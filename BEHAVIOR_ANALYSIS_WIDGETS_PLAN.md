# Behavior-Analysis Widgets on Real Intervention Events — Implementation Plan

Status: locked spec, ready for Kanban dispatch pending owner confirm. No code
changed. Produced from a 10-agent read-only research fan-out (2026-09-23)
against this repo, `~/.hermes/*.db`, `~/GitHub/sidecars`, and
`~/GitHub/Programming-Harness/decision-hub-integration`.

## 0. What triggered this

`Decision Hub — Linked Widgets` mockup (`~/Downloads/dashboard (1).html`) —
10 linked widgets over synthetic model×task data, admittedly fake:
multi-baseline/reversal/schedule-shape "intentionally bake in a step-change
... rather than pretending real deployment data already has one" (mockup's
own comment). Owner wants real data wired in, folded into the existing
Agent Matrix pane, no duplicate nav — per this repo's precedent
(commit `7a3e90f` "consolidate Agent Dashboard/Agent Matrix into one nav
entry").

## 1. Ladder check — does most of this need building at all?

**No.** `~/GitHub/decision-hud/plugin.js`'s `AgentMetricsWidgetsBody`
(commit `203bc91`) already ships 6 of the mockup's 10 widgets, on real
Kanban-derived data, with the exact cross-filter behavior the mockup
demos (click-to-isolate, shared `selected` state, dim/highlight):

| Mockup widget | Already built? | Real source |
|---|---|---|
| Heatmap | ✅ `AgentMetricsHeatmap` plugin.js:806 | `agent_metrics_snapshot.py` (Kanban task_runs) |
| Scatter | ✅ plugin.js:847 | same |
| Parallel coords | ✅ plugin.js:869 | same |
| Treemap | ✅ plugin.js:906 | same |
| Radar | ✅ plugin.js:942 | same |
| Sankey (handoffs) | ✅ `AgentMetricsSankey` plugin.js:985 | `task_links` parent↔child assignee pairs (623 real rows) |
| Multi-baseline | ❌ none | — |
| ABC alluvial | ❌ none | — |
| Fogg B=MAP | ❌ none | — |
| COM-B | ❌ none | — |

**Scope of this plan: the 4 missing widgets only.** Rebuilding the other 6
against the mockup's data shape would be strictly worse than what's live —
ladder rung 2, reuse what's already here. Close the mockup as
reference-only once this lands.

## 2. Why the 4 remaining widgets are genuinely blocked

All four are behavior-analysis views over a **discrete intervention event**
(multi-baseline: staggered intervention per model; ABC: antecedent→behavior→
consequence; Fogg: ability×motivation vs action threshold; COM-B:
capability/opportunity/motivation levers). None of that has meaning without
a real "something changed here, on purpose" timestamp per agent/model.

Confirmed (read-only, 7 sources checked): **no such event log exists
anywhere in this stack.**

- `decision_hud/queue.db`: decisions/problem_reports/hud_settings only, no
  routing/model concept.
- `state.db`: `gateway_routing` and `context_events` tables exist in schema
  but have **0 rows** — dead plumbing, not a real log.
- `~/.hermes/logs/agent.log`: has literal fallback-chain lines
  (`"main fallback chain to fallback_providers[0](openai-codex)"`) but is
  log-rotated, ephemeral, not queryable, gone after 3 rotations.
- `~/.hermes/cron/usage_audit.jsonl`: durable, timestamped, shows multiple
  models used over time — but it's a usage ledger, not a change-event log
  (no before/after, no reason code).
- Nearest reusable real signal: `session_model_usage.first_seen`/`last_seen`
  per (session, model) — reconstructible "model appeared/disappeared"
  timing, not an intentional swap marker.

**This needs new instrumentation.** Not a data-mapping exercise — genuinely
new telemetry, per the owner's own decision on this ("we'll need to do that
for real").

## 3. Data source map (per-widget, real sources only)

| Widget | Antecedent/x-axis | Behavior/y-axis | Real source | Gap |
|---|---|---|---|---|
| Multi-baseline | intervention window per model | rolling task-outcome rate | new `intervention_events` (below) for the window marker; `tasks`/`task_runs` outcome series for the line | needs intervention events |
| ABC alluvial | `tasks.block_kind` (capability/dependency/needs_input/scope/transient) as antecedent | retried? = `task_runs` count > 1 per task, or `block_recurrences > 0` | `tasks.block_kind`, `tasks.block_recurrences`, `tasks.consecutive_failures` | **none — fully real today, no new telemetry needed** |
| Fogg B=MAP | ability = 1 − (`consecutive_failures`/cap) | motivation = task completion rate | `tasks.consecutive_failures`, `task_runs.outcome` | none — real today |
| COM-B | capability/opportunity/motivation per model | same rollup, 3-axis relabel | `tasks.block_kind` (capability), `session_model_usage` cost (opportunity), completion rate (motivation) | none — real today |

**Correction to the MCQ framing**: only multi-baseline strictly needs the
new intervention-event log. ABC/Fogg/COM-B can ship on data that already
exists in `kanban.db` + `state.db` — no new telemetry required for 3 of
the 4. This changes the wave scope below (smaller than assumed).

## 4. New telemetry: `intervention_events`

Minimal, additive table in the existing decision-hud Postgres
(`agent_telemetry` schema — reuses the wave-1a owner decision, no new DB).

```sql
CREATE TABLE intervention_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope        text NOT NULL,          -- project_id, matches telemetry_snapshots.scope
    subject_id   text NOT NULL,          -- model name or assignee/profile name
    kind         text NOT NULL,          -- 'model_swap' | 'routing_change' | 'config_change' | 'provider_failover'
    reason       text,                   -- free text, optional
    occurred_at  timestamptz NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON intervention_events (scope, subject_id, occurred_at);
```

Write path (per owner's "A+B" answer — both a real capture point AND a
backfill sweep):

- **A — real-time capture**: append a row at the actual fallback/model-switch
  call site (`agent.auxiliary_client`'s fallback-chain logic — same place
  `agent.log`'s fallback lines already originate) and at
  `hermes provider switch`/cron-edit-schedule call sites already wired
  through `cliExec` for other decision-hud controls. Fail-open, mirrors
  `usage_audit.jsonl`'s append-only posture — never blocks the real call.
- **B — retroactive backfill**: one-time script deriving synthetic-but-real
  markers from existing signal for history before instrumentation existed:
  `session_model_usage` grouped by `(session.profile, model)` ordered by
  `first_seen` — a model's first appearance for a profile after a gap
  becomes a `model_swap` row with `payload.inferred=true`. Labeled
  inferred, never presented as identical confidence to a real capture.

## 5. Wave plan (matches this repo's established convention exactly)

Per repo convention (`AGENT_DASHBOARD_CONSOLIDATION_PLAN.md`,
`t_<8-hex>-wave-<N><letter>-<slug>` branches, `feat(waveNa): ...` commits,
isolated worktree per lane, sequential Wave 0/3, parallel Wave 1/2):

- **Wave 0 — canonical seam** (sequential, blocks everything):
  `intervention_events` migration + `write_intervention_event()` /
  `query_intervention_events(scope, subject_id, since)` repository methods,
  mirroring `PostgresMetricsRepository`'s existing method shapes.
- **Wave 1 — parallel backend** (isolated lanes, forked off Wave 0):
  - 1a: real-time capture call site + fail-open wiring
  - 1b: backfill script (inferred markers) + `history_begins_at`-style marker
  - 1c: `agent_metric_series` from `.hermes/plans/agent-health-timeseries-proposal-C.md` — design-complete, zero open questions, direct prerequisite for any sparkline on the new widgets. Build now, don't re-plan.
- **Wave 2 — parallel frontend** (isolated lanes, forked off Wave 0):
  - 2a: Multi-baseline widget (consumes `intervention_events` + task outcome series)
  - 2b: ABC alluvial widget (real today — `block_kind`/`block_recurrences`, no Wave 0/1 dependency, can start immediately)
  - 2c: Fogg B=MAP widget (real today — same, no dependency)
  - 2d: COM-B widget (real today — same, no dependency)
  - All 4 must join the existing cross-filter contract
    (`metricsRecordMatchesSelection`, `EMPTY_METRICS_SELECTION`,
    `AgentMetricsSelectionBar`) — not a separate selection mechanism.
- **Wave 3 — verify/merge gate** (sequential): full backend suite, frontend
  test sweep, `git diff --check`, merge each branch onto main one at a
  time with `git log origin/main` readback (per this repo's own R-I006
  lesson — a branch looking merged isn't proof), written acceptance-gate
  note distinguishing newly-real data from previously-validated data and
  any known-absent-field caveats (e.g. `payload.inferred=true` backfill
  rows are lower-confidence than live-captured ones).

**Note**: 2b/2c/2d have no hard dependency on Wave 0/1 — they can be
dispatched in parallel with Wave 0 if the owner wants faster wall-clock,
at the cost of the repo's normal sequencing discipline. Default: keep
Wave 0 first per convention unless told otherwise.

## 6. Explicitly out of scope for this plan

- **Sidecar cost/quality/latency data**: write path exists
  (`sidecar_service` → `telemetry_snapshots`, `producer=sidecars`) but has
  **zero real rows** — no live sidecar traffic has hit this DB. Not
  fixable by this plan; needs actual sidecar execution volume. Any widget
  that would show sidecar comparison stays labeled unavailable until rows
  exist.
- **Codex cost gap** (Gap B, `COST_COVERAGE_IMPLEMENTATION_PLAN.md`): owned
  by hermes-agent core (`agent/usage_pricing.py`), not this repo. Blocks
  ~60% of usage-row cost data. Not re-scoped here.
- **Usage burndown panel**: separate feature, 3 unresolved owner decisions
  (budget scope, week boundary, provider API key availability) — not
  re-asked here, stays parked in `USAGE_BURNDOWN_IMPLEMENTATION_PLAN.md`.
- **Session-linkage gap** (Gap A, same doc): needs a hermes-agent-side
  trace this repo can't do alone. Not re-scoped here.

## 7. Acceptance gate (Wave 3 checklist)

- [ ] ABC/Fogg/COM-B render real, non-fabricated numbers from `kanban.db` over an actual time window (not the mockup's seeded-random data)
- [ ] Multi-baseline renders real `intervention_events` rows; backfilled rows visibly marked inferred vs. live-captured
- [ ] All 4 widgets participate in the existing shared cross-filter (click one, others dim/isolate) — proven with one test exercising cross-widget selection
- [ ] Missing/unavailable data (no intervention events for a scope, no sidecar rows) renders an explicit unavailable state, never a fabricated zero
- [ ] Old mockup file is not referenced anywhere as a live route
- [ ] Full backend + frontend test suites pass; `git log origin/main` confirms every wave branch actually merged
