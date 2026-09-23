# Variety-improvement compatibility guardrails

Scope: before implementing any "variety improvement" mechanism (telemetry
columns, tie-breaking logic, wizard chains, UI additions) proposed by other
agents, check it against what Kanban blocker routing and Rule-1 batch
approval already depend on. Both ride the *same* `decisions` table, the
*same* MCP tool surface, and the *same* single-table-no-new-schema
convention already established in `db.py` (see `defer`/`escalation_necessity`
comments — this codebase already has a norm of "reuse existing columns, no
new tables").

## 1. What is load-bearing (must not change shape)

| Contract | Consumer | Why it's load-bearing |
|---|---|---|
| `decisions` table stays the single source of truth; no split into a second table/store for "variety" state | Kanban sweeper (`kanban_decision_resolution_sweeper.py`), `require_batch_approval()` | Both do direct `SELECT * FROM decisions WHERE ...` / `json_extract(card_payload_json, ...)`. A second table means every consumer needs a join or a second query path — silent data fork risk. |
| `card_type == 'batch_approval'` is the sole discriminator `require_batch_approval()` and the sweeper's batch-exclusion filters key off | `require_batch_approval()` (dispatch gate), `escalation_necessity_rate()` (explicitly excludes `card_type = 'batch_approval'`) | Any variety/tie-break logic that reassigns, renames, or overloads `card_type` values, or that lets a batch_approval row's `card_type` be mutated post-push, breaks dispatch gating (fail-open risk) or silently pollutes/quietly changes the necessity metric denominator. |
| `card_payload_json._kanban_task_id` / `_kanban_task_ids` keys | `kanban_escalation_bridge.py`, `kanban_decision_resolution_sweeper.py` | The sweeper's SQL literally does `json_extract(card_payload_json, '$._kanban_task_id')`. Renaming/nesting/moving this key breaks blocker routing with no error — the sweeper just stops finding rows. |
| `resolved_payload_json.action` contract-version scheme (structured `{"action": "unblock", "contract_version": 1}`; free text `resolved_choice`/labels are informational only) | Sweeper's resolution → task-transition step (per `decision-hud-blocker-routing` skill: "missing, legacy, malformed, unknown ... actions must fail closed") | If a variety/wizard-chain feature starts writing richer `resolved_payload_json` shapes for the *same* card types the sweeper reads, and the sweeper's parser isn't versioned/tolerant, it can either fail closed (safe but breaks flow) or — worse — be loosened to accept it and start acting on payloads that were never meant as commands. |
| `card_type` must remain server-verified via `_verify_card_type()` (bucket+answers → engine verdict) whenever set | Anything that pushes a typed card at all, including `batch_approval` today — currently `push_batch_approval()` bypasses this by inserting `card_type` directly, not through `push_decision()` | If "variety improvement" work extends card-type verification/enforcement to *all* pushers uniformly, `push_batch_approval()`'s direct INSERT must be explicitly exempted or it will start requiring bucket/answers that don't exist for approval gates and raise on every batch push. |
| UNIQUE `(project_id, batch_id)` index and its TOCTOU-safe insert path | `push_batch_approval()` | Any migration that touches the `decisions` table (e.g. adding indexes for new tie-break ordering) must preserve this constraint verbatim — dropping/recreating the table without it reopens the race F3 fixed. |
| `list_pending` ORDER BY / dedupe semantics that the sweeper and dispatch polling rely on for "don't create duplicate cards for the same blocker" | Kanban blocker routing (idempotent push-by-fingerprint) | If a new tie-breaking/variety-ordering feature changes `list_pending`'s ordering algorithm, it must not change *which rows are returned* or *the "still pending" dedupe semantics* — only presentation order. |

## 2. What is safely additive (variety work can freely use)

- New **nullable** columns on `decisions` with a safe default (`NULL` or a
  neutral default like `defer_count INTEGER NOT NULL DEFAULT 0` already
  models this pattern) — old readers (`SELECT *` + dict row factory) ignore
  unknown columns automatically; old writers never populate them, so
  defaults must make "absent" behave identically to today.
- New keys inside `card_payload_json` / `resolved_payload_json` that are
  **not** `_kanban_*` or `batch_id`/`task_list`/`action` — e.g. telemetry
  like `{"variety_score": ..., "shown_variants": [...]}`. Existing readers
  only look up specific keys via `json_extract`, so unrelated keys are inert.
- New `card_type` *values* for genuinely new card shapes, as long as they
  are never assigned to rows the sweeper/batch-approval logic already
  filters on (`'batch_approval'`, `'missing_constraint'`) and go through
  `_verify_card_type()` like the rest of the taxonomy.
- New MCP tools / CLI verbs that only *read* (`decision_list` supersets,
  telemetry dashboards) — read-only additions can't break a load-bearing
  writer.
- New tie-breaking logic *inside* `list_pending`'s ORDER BY, as long as the
  guardrail in §3 (return-set stability) is enforced by a test.

## 3. Concrete guardrails to enforce before merging

1. **Schema-additive-only rule, enforced by a test, not a comment.** Any
   migration for a variety mechanism must be a nullable `ALTER TABLE ADD
   COLUMN` with a safe default (mirroring `_migrate_v3_defer` /
   `_migrate_v4_columns`), never a rename/drop/type-change on `id`,
   `project_id`, `card_type`, `card_payload_json`, `resolved_choice`,
   `resolved_payload_json`, or `batch_id`. Add a schema-snapshot test (dump
   `PRAGMA table_info(decisions)` column names+nullability, assert the
   existing load-bearing set is a subset of any new snapshot) so a future
   migration can't silently narrow or rename them.

2. **`card_type='batch_approval'` and `card_type='missing_constraint'` are
   frozen contracts — variety/tie-break/wizard logic must treat them as
   opaque and never rewrite, reclassify, or run discriminant re-verification
   against existing rows of those types.** Concretely: `_verify_card_type()`
   enforcement, any new tie-break scoring, and any wizard-chain follow-up
   questions must all early-return/no-op when `card_type in
   ('batch_approval', 'missing_constraint')`, exactly as
   `escalation_necessity_rate()` already excludes `batch_approval` from its
   denominator. Add a regression test that pushes one of each and asserts a
   representative "variety" pass leaves `card_type`, `card_payload_json`,
   and `resolved_payload_json.action` byte-identical apart from fields it's
   explicitly allowed to append.

3. **`card_payload_json`/`resolved_payload_json` are additive-merge only for
   Kanban/batch-linked rows.** Any code that rewrites these JSON blobs
   (telemetry annotation, variety scoring, wizard-chain state) must
   read-modify-write by merging into the existing dict and must never touch
   keys prefixed `_kanban_` or the batch keys (`batch_id`, `task_list`) or
   `resolved_payload_json.action`/`contract_version`. Land this as a shared
   helper (`_merge_card_payload(existing, additions)` that asserts the
   protected-key set is untouched) so every variety feature funnels through
   one enforcement point instead of each call site promising to be careful —
   this is the same "fix it once where all callers route through" principle
   already used for `_verify_card_type()`.

## Bottom line

Kanban blocker routing and Rule-1 batch approval both already lean on this
codebase's own stated convention (ride existing columns/JSON keys, no new
tables, `card_type` as sole discriminator). The three guardrails above are
just making that convention *enforced* (schema snapshot test + protected-key
merge helper + frozen-card-type no-op) rather than merely documented, so a
variety-focused redesign can ship without a human having to re-derive "wait,
does this break the sweeper" by reading `db.py` end to end each time.
