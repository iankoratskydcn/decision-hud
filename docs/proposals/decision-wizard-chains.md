# Decision Wizard Chains — proposal

Status: **proposal**. Nothing in this doc exists in `db.py` or `plugin.js` today except what's explicitly marked REAL. No schema migration is proposed — every mechanic below rides on existing `card_payload_json` / `resolved_payload_json` JSON blobs, the same way `batch_approval` and `missing_constraint` already piggyback on those columns instead of adding new ones (see `db.py` module comments citing a "hard cap of 3 schema-fragmentation mechanisms" — a 4th schema-level mechanism is not proposed here; this reuses the pattern, it doesn't add a table/column).

## 1. What's REAL today (grounding)

- Schema (`decisions` table, `db.py`): `id, project_id, question, choices_json, recommended, urgency, created_at, card_type, card_payload_json, resolved_choice, resolved_at, resolved_payload_json, defer_log_json, last_deferred_at, defer_count, batch_id, resolved_by`.
- `decision_hud__decision_push(question, choices, card_type=None, card_payload_json=None, card_type_bucket=None, card_type_answers_json=None, ...)` inserts ONE row. There is no multi-row/transaction primitive.
- `card_type` requires `card_type_bucket` + `card_type_answers_json` and is verified server-side by `_verify_card_type()` against the deterministic engine (`_CARD_TYPE_RULES`) — a caller cannot just assert a card_type string.
- `card_payload_json` and `resolved_payload_json` are **opaque JSON blobs to the DB layer** — `db.py` never inspects their internal keys except for `batch_approval`'s `batch_id`/`task_list` and `missing_constraint`'s `task_id`/`question`, both read via `json_extract` on specific known keys. Any new keys inside these blobs (e.g. a wizard tag) are free — no migration needed to add them.
- Resolution is **asynchronous**: `resolved_choice`/`resolved_payload` are set only when a human opens the desktop pane and clicks Confirm; there is no callback/webhook. An agent finds out by polling `decision_check`/`decision_list` on a later turn or a later cron/session.
- There is **no existing chaining, sequencing, or "part N of M" concept anywhere in `db.py` or the skill docs.** Everything below is new.

## 2. Core mechanic: chain state lives entirely in `card_payload_json`

No new column. A "wizard" is a plain sequence of ordinary `decisions` rows, linked by a shared key placed inside each row's `card_payload` — same idiom as `batch_id`, except `batch_id` earned a real column because `push_batch_approval` needed a DB-level UNIQUE constraint. A wizard chain has no uniqueness constraint to enforce (a project can run several wizards, cards can be re-pushed if the user wants to redo a step), so it doesn't need to graduate off `card_payload_json` — proposing the column would be over-engineering for what "hard cap of 3" already warns against.

Proposed (not real) convention, `wizard` sub-object nested in every chained card's `card_payload`:

```json
{
  "wizard": {
    "wizard_id": "wz_8f2a1c",
    "step": 2,
    "of": 3,
    "title": "Cache layer rollout",
    "depends_on_decision_id": "a1b2c3d4e5f6",
    "chain_state": { "...": "carried-forward values, see §3" }
  },
  "...rest of card_type's normal payload fields unchanged..."
}
```

- `wizard_id`: agent-generated short random token (same style as decision `id` — `uuid4().hex[:12]` truncated further, e.g. `wz_` + 6 hex chars), scoped to one `project_id` the way `batch_id` is. Not DB-enforced unique (no new index proposed) — a collision just means two unrelated wizards share a label, cosmetically confusing but not corrupting; acceptable risk for a UI grouping key with no dispatch-gating consequence, unlike `batch_id`.
- `step` / `of`: 1-indexed position and total count. This is the literal "part 2 of 3" data; the UI reads these two ints, nothing fancier.
- `depends_on_decision_id`: the real `id` of the immediately-prior card in the chain (or `null` for step 1). Lets the pane draw a chain even if `wizard_id` were ever ambiguous, and lets an agent look up the exact prior row instead of assuming ordering.
- `chain_state`: agent's own accumulated scratch object, forward-carried and grown at each step (see §3). Not read or validated by `db.py` — pure agent-side convention.

Nothing here requires touching `_verify_card_type()`, `_CARD_TYPE_RULES`, or the discriminant engine — `wizard` is a sibling key next to whatever payload keys the chosen `card_type` already needs (e.g. `scalar_slider`'s `{min,max,step,default,unit}` plus a `wizard` key alongside it). The card-type gate classifies the *shape of step N's own question*; it has no opinion on chaining and doesn't need one.

## 3. How card N's payload is built from card N-1's `resolved_payload`

Concrete worked example: step 1 is a `scalar_slider` picking a cache TTL ceiling; step 2 is an `anchor_adjust` recommending per-region defaults seeded from that ceiling.

**Step 1 push** (real tool call, `card_type_bucket="scalar"`, discriminants resolve to `scalar_slider`):
```json
{
  "question": "Wizard 1/2: pick the cache TTL ceiling",
  "card_type": "scalar_slider",
  "card_payload": {
    "min": 10, "max": 3600, "step": 10, "default": 300, "unit": "s",
    "wizard": {"wizard_id": "wz_8f2a1c", "step": 1, "of": 2, "title": "Cache rollout", "depends_on_decision_id": null, "chain_state": {}}
  }
}
```

**Between steps** (agent-side, not a `db.py` feature): on a later turn, the agent calls `decision_check`/`decision_list`, finds this row's `resolved_payload = {"value": 900}` (the real `scalar_slider` resolve shape per `decision-hud-cards`), and reads `card_payload.wizard` back off the SAME resolved row to recover `wizard_id`, `step`, and prior `chain_state`.

**Step 2 push**, built by the agent from step 1's resolved value:
```json
{
  "question": "Wizard 2/2: confirm or override per-region TTLs (defaults from your 900s ceiling)",
  "card_type": "anchor_adjust",
  "card_payload": {
    "fields": [
      {"key": "us-east-1", "label": "US East", "default": 900, "options": [300, 600, 900, 1800]},
      {"key": "eu-west-1", "label": "EU West", "default": 900, "options": [300, 600, 900, 1800]}
    ],
    "wizard": {
      "wizard_id": "wz_8f2a1c", "step": 2, "of": 2, "title": "Cache rollout",
      "depends_on_decision_id": "<step-1's real id>",
      "chain_state": {"ttl_ceiling": 900}
    }
  }
}
```

The derivation rule in general: **`default` fields of card N are computed by the agent, in plain Python/logic, from `card N-1.resolved_payload`, before calling `decision_push` for card N.** `db.py` does nothing here — there is no server-side templating or variable substitution. This is deliberate: adding a templating engine to `db.py` so card N's payload could declare `"default": "{{prev.value}}"` would be new code solving a problem the agent's own turn loop already solves for free (rung 2/3 of the ladder — reuse what's there: the agent is already a Python-capable process that can read one JSON blob and write another).

## 4. "Part N of M" in the queue UI — what's proposed on the plugin.js side

Not implemented. Concretely, since `wizard` is a nested `card_payload` key, `DefaultChoiceCard`/`CardErrorBoundary` and every existing `CARD_RENDERERS` entry already tolerate an unknown extra key (they read only the keys their own contract documents) — so no renderer breaks by this data existing. The proposed additive rendering change:

- Each card component's outer wrapper (or a shared `HudCardShell` if one exists / gets factored out) checks `decision.card_payload?.wizard` and, if present, renders a small header chip above the card's own tag: `"{title} — step {step} of {of}"`, e.g. `"Cache rollout — step 2 of 2"`.
- If `depends_on_decision_id` is set and that decision is still unresolved (shouldn't normally happen if the agent pushes sequentially, but the pane polls independently), grey out step 2's card with a "waiting on step 1" note rather than presenting it as actionable — purely a display nicety, not a hard gate (nothing prevents a human from resolving step 2 first if they want to; the agent is the one that should avoid pushing step 2 before step 1 resolves).
- Sort key: within the existing `list_pending` ordering (urgency, then defer-tiebreak, then `created_at`), no change — pushing steps sequentially in order already means step 1's `created_at` predates step 2's, so natural ordering already clusters a chain contiguously in most cases. No new ORDER BY clause proposed.

This is UI-only, additive, and skippable — a chained card with no plugin.js awareness of `wizard` still renders completely correctly today via its normal `card_type` renderer; the chip is decoration, not a dependency.

## 5. When does the agent decide a decision is "compound enough" for a chain vs. one card vs. unstructured sidecar decomposition?

Three-way decision, not two-way — restating the brief's framing precisely:

1. **One card** — the question survives being classified by `card-type-gate`'s discriminant engine into exactly one bucket, and the resulting `card_payload` doesn't need any *externally-decided* value it doesn't already have. Default path; almost every decision.
2. **Wizard chain (2-3 cards)** — reach for this only when BOTH hold:
   - The question genuinely decomposes into an **ordered sequence of dependent sub-decisions**, where sub-decision N's *reasonable options/defaults* materially change based on sub-decision N-1's answer (not just "the topic is related" — actual data dependency, per §3's worked example). If step 2's payload would be identical regardless of step 1's answer, it isn't a dependency, it's just two unrelated decisions that happen to share a project — push them as two independent single cards, not a chain.
   - Forcing it into one card would require a `card_type` that doesn't actually fit the question's shape per the gate's discriminant rules (e.g. the question is really "pick a scalar AND THEN, conditioned on that scalar, allocate a budget across categories" — no single card_type in the 23 models both a scalar pick and a conditioned allocation at once; `assemble_pieces` is the closest and it's wrong because its slots aren't allowed to have cross-slot numeric dependencies).
   - Hard cap: **3 steps.** If decomposition wants a 4th step, that's a sign the underlying decision needs to be re-scoped by the human (a real conversation, not a wizard) rather than the agent inventing more automated cards — same "don't paper over a bigger problem" instinct behind `missing_constraint`'s PO-escalation design.
3. **Unstructured sidecar decomposition** (independent standalone cards, no `wizard` payload key, no sequencing) — use this when sub-questions are genuinely independent (no data flows from one answer to shape another's options) even though they arose from the same original ambiguous ask. This is just "push N ordinary decisions," already fully supported today with zero new mechanic — it's the right default whenever dependency is absent, and should be preferred over a chain when in doubt, since a chain adds process (agent must poll, wait, and construct payload N from payload N-1) that buys nothing if there's no real dependency to carry forward.

Decision rule stated as a gate an agent can run mechanically before choosing a path:
```
if single card_type resolves cleanly (per card-type-gate) and no sub-part
   needs another sub-part's chosen value as a default/config input:
       push ONE card
elif sub-parts have a genuine value-dependency chain, count <= 3:
       push a WIZARD (linked via card_payload.wizard, built sequentially,
       agent polls resolved_payload between each push)
else:
       push N INDEPENDENT cards (no wizard key) — sidecar decomposition
```

## 6. Explicit list: real vs. proposed

| Mechanic | Status |
|---|---|
| `decisions` table columns, `decision_push`/`decision_check`/`decision_list`, card-type-gate verification | REAL, unchanged |
| `card_payload_json` / `resolved_payload_json` as opaque agent-defined JSON | REAL (existing columns, existing opacity) |
| `wizard` key nested inside `card_payload` (`wizard_id`, `step`, `of`, `title`, `depends_on_decision_id`, `chain_state`) | PROPOSED — new convention, zero schema change, zero new tool params |
| Agent-side "read resolved_payload, compute next payload, push next card" loop | PROPOSED — pure agent logic, no new `db.py`/MCP code |
| plugin.js header chip showing "step N of M" + waiting-state greyout | PROPOSED — additive UI change, degrades to today's exact behavior if skipped |
| 3-step hard cap, dependency-vs-independence decision rule | PROPOSED — process/judgment convention, not enforced in code (could be, but isn't proposed here — enforcing it would mean `db.py` inspecting `card_payload.wizard.of` and rejecting >3, which is more validation than a UI-grouping label needs; leaving it a convention is the smaller change) |

## 7. Why no new column, no new MCP params (ponytail rationale)

- A `wizard_id` DB column + UNIQUE index would mirror `batch_id`'s pattern, but `batch_id` needed hard uniqueness because `require_batch_approval` is a **dispatch gate** — an ambiguous/duplicate batch could let unapproved work through. A wizard chain gates nothing; it's a display grouping. No correctness property depends on `wizard_id` collisions never happening, so the cheaper (JSON-blob, no migration) option is correct here, not merely convenient.
- A new `decision_push(..., wizard_id=, wizard_step=, wizard_of=)` parameter set would require touching the MCP tool schema, the CLI, `push_decision()`'s signature, and `_row_to_dict()` — four call sites — to do exactly what nesting a dict inside the already-passed `card_payload_json` does in zero. `card_payload_json` was designed to be an arbitrary JSON blob for exactly this kind of "renderer needs more context" case; using it is the smallest change, not a workaround.
