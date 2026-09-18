# Decision HUD → Kanban Resolution Remediation Plan

> **For Hermes:** Use `parallel-subagent-contract` and `requesting-code-review` to implement this plan task-by-task.

**Goal:** Make an owner-resolved Decision HUD blocker card safely perform its explicitly selected Kanban action, while leaving ambiguous, stale, legacy, or rejected resolutions blocked.

**Architecture:** Extend the existing `kanban_decision_resolution_sweeper.py`; do not add a service, queue, database, or agent executor. Decision HUD remains the authority for human resolution. The sweeper normalizes legacy/current links, validates a versioned structured action, invokes only an allowlisted existing Kanban CLI transition, and verifies the target by read-back. Existing unresolved/legacy cards remain visible but cannot unblock work until reissued under the explicit contract.

**Tech Stack:** Python, SQLite read model, existing `hermes decision`/`hermes kanban` CLIs, Decision HUD plain MCQ cards, existing cron sweep.

---

## Synthesis of the 20 plans and 5 reviews

Accepted consensus:

- Reuse the existing sweeper. A new operation service, agent executor, distributed queue, or schema is overbuild and adds a second authority seam.
- Deterministic code may execute a human-approved action; an agent may classify unresolved blockers only, never resolve or execute them.
- `resolved_choice` is display text, not authority. Only an exact structured `resolved_payload` action may authorize mutation.
- `leave_blocked`, missing payload, malformed payload, unknown action, stale task, wrong board/project, and legacy rows all fail closed.
- Use `hermes kanban unblock` for blocked work and verify with `hermes kanban show --json`; do not use `promote` as a substitute.
- Keep `review` cards comment-only; never auto-complete or reopen review from this path unless a later explicit contract is added.
- Normalize singular and plural link formats for compatibility, but make singular `(board, task, root, decision-key)` ownership the canonical execution identity.
- Separate stable triage identity from volatile evidence. Repeated sweeps update one pending card rather than creating card spam.

Discarded or deferred:

- New operation service / receipt database / leases before the existing cron path proves insufficient.
- Autonomous remediation agents.
- New card renderer or universal action framework.
- Broad taxonomy expansion.
- Full deployment/canary infrastructure; use a dry-run and one-task live canary first.
- One reviewer response focused on unrelated sandbox/isolation work; it is outside this feature's authority boundary and is not used for implementation decisions.

## Contract

New triage cards carry a versioned payload fragment:

```json
{
  "_triage_contract_version": 1,
  "_triage_fingerprint": "sha256(project|board|root|kind)",
  "_triage_kind": "kanban_blocked",
  "_kanban_board": "default",
  "_kanban_root_task_id": "t_root",
  "_kanban_task_id": "t_root",
  "_kanban_task_ids": ["t_root", "t_child"],
  "_kanban_status": "blocked",
  "_kanban_resolution": {
    "allowed_actions": ["unblock", "leave_blocked"],
    "default": "leave_blocked"
  },
  "evidence": []
}
```

The existing plain choices remain strings (to preserve the renderer contract), for example:

- `Unblock after verification`
- `Leave blocked`

The card renderer stores the exact structured result in `resolved_payload`, e.g. `{ "action": "unblock", "contract_version": 1 }`. Labels and free text never authorize execution.

For grouped descendants, retain plural IDs for evidence/display, but only the canonical root task is an executable owner target. Descendants remain dependency-gated and are never recursively unblocked by proximity.

## Implementation tasks

### Task 1: Add failing contract tests

**Files:**
- Modify: `backend-plugin/tests/test_triage_blocked.py` (create if absent)
- Modify: `/home/ian-koratsky/.hermes/scripts/test_kanban_decision_resolution_sweeper.py`

Add tests for:

- singular and plural link normalization;
- duplicate/empty/malformed links ignored with no mutation;
- missing or unknown `_kanban_status` fails closed;
- explicit structured `action=unblock` is the only path that calls `unblock`;
- `leave_blocked`, missing payload, malformed payload, and arbitrary text never call `unblock`;
- pending sibling prevents action;
- stale/non-blocked target skips action;
- multiple parents and cycles do not cause recursive unsafe action;
- repeated sweeps produce no duplicate comment/unblock action;
- legacy cards remain readable but do not auto-unblock;
- card identity is stable when evidence ordering/timestamps change.

Run the tests and preserve RED evidence before implementation.

### Task 2: Normalize and validate sweeper links

**Files:**
- Modify: `backend-plugin/scripts/kanban_decision_resolution_sweeper.py` (tracked source of truth)
- Sync target: `~/.hermes/scripts/kanban_decision_resolution_sweeper.py`

Add one pure normalizer that accepts:

1. canonical singular `_kanban_task_id` + `_kanban_status`;
2. legacy plural `_kanban_task_ids` + explicit status;
3. optional `_kanban_links` only if it is strictly typed.

Reject empty IDs, unknown statuses, mixed status groups, malformed containers, cross-board links, and missing root ownership. Deduplicate by `(decision_id, task_id, status)` and preserve deterministic ordering. Never infer status from the current Kanban row or choice text.

### Task 3: Add explicit resolution gate

**Files:**
- Modify: `backend-plugin/scripts/kanban_decision_resolution_sweeper.py`
- Modify: triage card creation code in `plugin.js` and `backend-plugin/cli.py`

Add a single `can_apply_resolution(card_group)` predicate:

- all required cards are resolved;
- all cards carry the same supported contract version and resolution policy;
- every resolved payload is an object with exact `action=unblock`;
- `leave_blocked`, missing/malformed/unknown actions, and legacy rows return false;
- status is exactly `blocked`;
- current target is still `blocked`;
- all required parent checks pass.

If false, post an audit/progress comment only and keep the task blocked. For `review`, comment only.

### Task 4: Execute one allowlisted transition and verify it

**Files:**
- Modify: `backend-plugin/scripts/kanban_decision_resolution_sweeper.py`

Use only the existing CLI path:

```text
hermes kanban show <task_id> --json
hermes kanban comment <task_id> <audit text>
hermes kanban unblock <task_id>
hermes kanban show <task_id> --json
```

Before mutation, verify project/board identity, task ID, current status, parent state, contract version, and action. After `unblock`, require a successful CLI result plus a second `show --json` confirming the task is no longer `blocked` (normally `ready` or parent-gated `todo`). If either read-back fails, report unresolved and retry on the next sweep; do not mark the operation complete based on exit code alone.

Keep the current state-file idempotency, but mark a decision/task edge processed only after its comment/action/read-back succeeds. A failed comment or failed transition must remain retryable.

### Task 5: Add stable triage-card dedupe

**Files:**
- Modify: `backend-plugin/cli.py`
- Modify: `backend-plugin/db.py` only if an existing helper is needed; avoid schema migration
- Modify: triage tests

Compute a stable fingerprint from canonical project ID, board slug, root task ID, and triage kind. Exclude titles, evidence ordering, timestamps, and volatile run IDs. Repeated pending triage runs find/update the existing card. A resolved card is immutable; materially new evidence may create one new epoch/card rather than reopening history. Do not add a uniqueness index until a live SQLite compatibility check proves it is necessary; application-level canonical matching is the ponytail-sized first cut.

### Task 6: Fix orphaned auxiliary reports

**Files:**
- Modify: `backend-plugin/cli.py`
- Add test: `backend-plugin/tests/test_triage_blocked.py`

If auxiliary triage fails after creating a problem report, mark the report as failed/handled through the existing report lifecycle or avoid creating it until the auxiliary path is confirmed available. Never silently leave an orphaned pending report. The deterministic fallback still creates a bounded plain MCQ card.

### Task 7: Harden the button's graph fetch

**Files:**
- Modify: `plugin.js`
- Modify: `test/triage-blocked-work.test.mjs`

Normalize wrapped and bare Kanban JSON responses. Do not let one failed `show` request make the entire sweep look successful: show a visible error with task ID, omit that task from action groups, and keep the operation retryable. Keep the explicit selected-board scope.

### Task 8: Sync and canary

**Files:**
- Modify tracked backend script only; sync to `~/.hermes/scripts` using the existing repository sync mechanism.

Verification sequence:

1. Run Python syntax checks and the existing sweeper test directly.
2. Run all new pure tests.
3. Run `node --check plugin.js` and the triage structural test.
4. Dry-run against the current board: report groups/actions, perform no Kanban mutation.
5. Seed one disposable blocked test task with one explicit `unblock` decision and one `leave_blocked` decision; verify only the explicit unblock path changes state.
6. Read back the task and Decision HUD row after each sweep.
7. Run two sweeper invocations concurrently; verify one action.
8. Re-run after a failed CLI/read-back and verify retry without duplicate mutation.
9. Disable/stop the sweeper and verify no further actions occur.
10. Preserve unrelated `33dfcb0` origin-chat commit as a separate feature.

## Acceptance gate

The gap is closed only when:

- clicking a valid explicit `Unblock` decision causes one verified Kanban transition;
- clicking `Leave blocked` causes no transition;
- existing/legacy cards cannot implicitly unblock work;
- stale, malformed, unauthorized, cross-board, or ambiguous inputs fail closed;
- grouped descendants do not bypass parent gating;
- duplicate sweeps and crash/retry paths produce at most one transition;
- all attempted transitions have authoritative post-action read-back;
- no arbitrary command, agent executor, new database, or new service exists;
- the dry-run and disposable live canary pass;
- the origin-chat metadata commit remains isolated and tested separately.
