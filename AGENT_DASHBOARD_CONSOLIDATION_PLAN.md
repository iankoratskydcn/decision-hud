# Agent Dashboard / Agent Matrix Consolidation — Staged Wave Plan

> Methodology ported from the sidecar project (`~/GitHub/sidecars/SIDECAR_RANKING_AND_EVALUATION_PLAN.md`,
> `SIDECAR_BRANCH_UNTANGLING_PLAN.md`): canonical seam lands first, then isolated-worktree
> parallel waves gated by a paused Kanban board, cross-provider adversarial review per unit,
> and a fixed merge-verification ritual before anything touches `main`.

## Current state (verified 2026-09-22)

- **Agent Dashboard** (`/decision-hud/agent-dashboard`): Postgres-backed, `telemetry.v1`
  schema, real project-scoped Bearer auth. `docker-compose.yml` exists but is never run as a
  persistent service → 127.0.0.1:55432 not listening → 503 in the UI.
  `backend/scripts/sync_kanban_telemetry.py` can read real Kanban outcome counts and write
  `telemetry.v1` checkpoints, but **no cron/scheduler ever invokes it** — even if Postgres were
  up, the table would stay empty. Only outcome-volume metrics are captured; token/cost/latency
  fields the schema supports (`values` dict, open-ended `category`) are never populated.
- **Agent Matrix** (`/decision-hud/agent-metrics/snapshot`): local SQLite via
  `hermes decision agent-metrics-snapshot`, always fresh, 6 working visualizations (heatmap,
  scatter, parallel coordinates, treemap, radar, sankey). No history — point-in-time only.
- **Sidecar project** (`~/GitHub/sidecars/sidecar_suite/contract.py`): every sidecar operation
  already runs through `execute()`, which builds a structured `sidecar.measurement` event per
  call — `task_id`, `run_id`, `attempt_id`, `idea_id`, `operation`, `status`, `reason_code`,
  `provenance` (execution_path/model_id/model_version), `measurement` (started_at/
  first_token_at/completed_at/input_tokens/output_tokens/token_status/latency_ms) — and hands it
  to an `event_sink` callback. **No persistent sink is wired anywhere**; callers (tests,
  one-shot harnesses) pass throwaway sinks. This is real, already-shaped per-call cost/quality/
  latency data going nowhere, same failure mode as the Kanban side.
- Three data sources, three shapes, zero shared destination, no shared scope/project selection.

## Wave 0 — Canonical seam (sequential, must land on `main` before anything else starts)

Single branch, single PR, blocks every later wave (mirrors the sidecar project's `e5f7d26` seam
commit that 96/98 idea branches were rebased onto).

1. **Owner decision: rename.** Rename the backend package `agent_dashboard` →
   **`agent_telemetry`** (keeps "Agent Dashboard" as the UI label per your prior recommendation,
   but the backend name stops colliding conceptually with the thing it's replacing/absorbing).
   Update imports, `pyproject.toml`, `http_app.py` route module refs. Route path stays
   `/decision-hud/agent-dashboard` (no client-facing break).
2. **Make Postgres persistent**, not a manual `docker-compose up`. Wire it as a Hermes-managed
   background service (systemd user unit or an entry in whatever already supervises other
   Hermes sidecars on this host) so it survives reboot and doesn't silently die again.
3. **Cron the sync.** Add a Hermes cron job running `sync_kanban_telemetry.py` on a fixed
   interval (start at every 15 min, matching the existing Kanban healthcheck cadence style).
   This alone fixes "should be getting measured" for outcome volumes.
4. **Extend the measurement envelope** (resolved, no new logging needed): `task_runs`
   (Kanban's own table) has NO token/cost columns — only status/outcome/summary/metadata/error.
   Real per-call token/cost/latency already lives in the `sessions` table
   (`hermes_state_usage.py`): `input_tokens`, `output_tokens`, `cache_read_tokens`,
   `cache_write_tokens`, `reasoning_tokens`, `estimated_cost_usd`, `actual_cost_usd`,
   `api_call_count`, kept live by a background coalescing writer. Kanban worker sessions are
   already linked to their `task_id` via the existing `retag_kanban_worker_sessions()`
   mechanism (`hermes_cli/kanban_db_dispatch.py`). So this step is a JOIN, not new
   instrumentation: `sync_kanban_telemetry.py` reads `task_runs` JOIN `sessions` (via the
   retag linkage) and writes the token/cost/latency columns into additional `telemetry.v1`
   `values` entries (e.g. `category: "model_cost_latency"`) alongside the existing
   outcome-volume values — same schema, no format change, no second logging path.
5. **Add a persistent `sidecar.measurement` event_sink.** `sidecar_suite/contract.py:execute()`
   already emits a fully-shaped per-call event (tokens, latency, provenance, status,
   reason_code) — it just needs a sink function that maps that event onto a `telemetry.v1`
   `MetricSnapshot` (agent_id = `idea_id`/`operation`, scope = a fixed `"sidecars"` project
   scope, values = the `measurement` + `provenance` dict) and calls the same
   `PostgresMetricsRepository.write_checkpoint()` path `sync_kanban_telemetry.py` uses. Land
   this as a small adapter module (e.g. `sidecar_suite/telemetry_sink.py`) in the sidecars repo,
   imported by whatever currently constructs the throwaway sinks in tests/harnesses — swap the
   default sink, not the `execute()` contract itself (contract is locked; don't touch it).
6. Merge ritual: fresh venv, `pytest` + `compileall` + `git diff --check`, push, verify on
   `origin/main` via `git log`. This is the seam everything below forks from. Applies to BOTH
   repos touched in this wave (`decision-hud` and `sidecars`) — each gets its own commit/push,
   verified independently.

**Exit gate for Wave 0:** `curl 127.0.0.1:55432` reachable, cron job present and has fired at
least once, `telemetry_snapshots` table has rows newer than the cron job's start time with
non-outcome-only `values` from BOTH sources (Kanban outcomes AND at least one live sidecar
`sidecar.measurement` event), distinguishable by `producer` (`"kanban-sync"` vs `"sidecars"`,
see Resolved decisions below) so they're joinable but never silently blended.

## Wave 1 — Parallel backend work (isolated worktrees, forked off Wave 0's `main`)

No shared-file contention between these four (mirrors sidecar per-idea branches touching only
their own module):

- **1a. Dual-repository read model.** Give `DashboardReadModel` a second, explicitly-labeled
  data path for Agent Matrix's live SQLite source, so one read model can serve both
  "historical Postgres" and "live local" sections without a second HTTP surface. Never blend
  the two into one number — keep sources visibly tagged per the original owner decision on
  authority boundaries.
- **1b. Freshness/staleness contract.** Explicit states: `live`, `stale` (Postgres up but no
  recent sync), `unavailable` (Postgres down) — replaces the current binary 503-or-nothing.
- **1c. Backfill script.** One-shot job to seed Postgres history from however far back Kanban
  SQLite retains `task_runs`, so day one isn't an empty chart. Sidecar side has no comparable
  backfill (events were never captured before Wave 0), so its history simply starts at Wave 0's
  cutover — call this out explicitly in the UI rather than implying equal-length history.
- **1d. Cross-source cost/quality/speed comparison view.** This is the actual point of tying
  sidecar metrics in: a read-model query that, per agent/operation, surfaces
  `input_tokens`/`output_tokens`/`latency_ms`/`quality_score` (where available) side by side
  across `path` values (`baseline`, `sidecar_shadow`, `sidecar_active`, plain Kanban agent
  runs) — the same comparator shape `SIDECAR_RANKING_AND_EVALUATION_PLAN.md`'s "Derived
  metrics" section already defines (net token savings, avoidance rate, latency delta, quality
  retention). Don't invent a new metric vocabulary; reuse that one so sidecar and non-sidecar
  agent runs are directly comparable, which is what lets you actually iterate on cost/quality/
  speed instead of just staring at two separate charts.

Each gets its own worktree/branch, its own focused test file, cross-provider AR review
(Anthropic + one other provider, unanimous APPROVE) before merge — same as the sidecar `AR-*`
review cards.

## Wave 2 — Parallel frontend work (isolated worktrees, forked off Wave 0's `main`)

- **2a. New canonical page** at `/decision-hud/agent-dashboard`: dashboard read-model section
  (health, freshness state, categorized metrics, scope/project picker) stacked above the Agent
  Matrix visualization section (heatmap/scatter/parallel-coords/treemap/radar/sankey), sharing
  one board/project selector — no duplicate pane tree.
- **2b. Retire `/decision-hud/agent-metrics`** as a visible nav entry; keep as a redirect/alias
  for one release cycle, not a second page.
- **2c. Explicit unavailable-state UI** per section (don't let one backend's downtime blank the
  other section) — this preserves the "never fabricate data" rule from the prior architectural
  review.
- **2d. Cost/quality/speed comparison panel**, fed by Wave 1d's cross-source query: per-agent
  and per-operation token/latency/quality bars, with a filter to isolate `sidecar_active` vs
  `baseline` vs plain Kanban-agent paths. This is the concrete surface for "iterate on
  cost/quality/speed" — without it the joined data from Wave 0/1 has nowhere to be looked at.

Same worktree/branch/AR-review discipline as Wave 1.

## Wave 3 — Verification and rollout (sequential, gates completion)

1. Merge all Wave 1 + Wave 2 branches onto Wave 0's `main` one at a time (never rely on "based
   on main" alone — confirm each is actually merged *into* `main`, per the lesson from the
   sidecar project's `R-I006` incident where a branch sat unmerged despite looking done).
2. Full merge ritual after each: fresh venv, pytest, compileall, `git diff --check`, push,
   `git log origin/main` readback.
3. **Acceptance gate — do not call this done until:**
   - Dashboard section shows real, non-fabricated metrics spanning at least 24h of actual cron
     activity (not a synthetic seed).
   - Killing the Postgres service shows the explicit `unavailable` state, not a blank page or
     fake numbers.
   - Agent Matrix section keeps working independently when Postgres is down.
   - Old `/decision-hud/agent-metrics` route redirects correctly.
   - At least one real sidecar operation run's `sidecar.measurement` event is visible in the
     comparison panel, correctly scoped separately from Kanban agent data, joinable but not
     blended.
4. Post an interpretation note on the final review card: outcome-volume metrics were already
   real (Kanban-sourced); token/cost/latency metrics — for both Kanban agent runs AND sidecar
   operations — are new in this consolidation and should be spot-checked against known runs,
   not assumed correct from schema validity alone. Sidecar quality_score is frequently absent
   (shadow-mode runs don't always score) — an empty field means "not yet judged," not zero.

## Resolved decisions

- **Ian, #4:** "just push them to the same place." Resolved without any schema change:
  `telemetry.v1`'s `MetricSnapshot.from_dict` (`contracts.py`) already validates a strict,
  fixed field set (`SNAPSHOT_FIELDS`) that includes two unused-in-practice fields —
  `producer` and `source` — built for exactly this. Kanban-sync checkpoints set
  `producer="kanban-sync"`; the new sidecar sink sets `producer="sidecars"`. Both write into
  the *same* `telemetry_snapshots` table, same `scope` dimension stays "project," `producer`
  is what lets a query split or join the two without inventing a new column or bumping the
  schema version. Wave 0 steps 4/5 and Wave 1d updated below to use `producer`, not a new
  `source_system` field.
- **Ian, #5:** shim it — existing sidecar tests work well and must not be disturbed.
  `sidecar_suite/telemetry_sink.py` (Wave 0 step 5) becomes an *additive* sink, not a
  replacement: `execute()`'s `event_sink` parameter is unchanged, but the harness/CLI entry
  points that currently construct throwaway sinks for live (non-test) runs get a
  `tee_sink(*sinks)` wrapper that fans one event out to the existing throwaway sink AND the
  new Postgres sink. Test files that construct their own sink keep passing exactly what they
  pass today — zero test changes required. Only the live-run entry points opt into the tee.
- **Ian, #1:** confirmed. Rename `agent_dashboard` → `agent_telemetry`; UI label stays
  "Agent Dashboard."
- **Ian, #2:** "no idea, but it should be the persistent logging in the Postgres." Traced
  directly in the hermes-agent codebase (not guessed): Kanban's own `task_runs` table has no
  token/cost columns. Real per-call token/cost/latency already lives in the `sessions` table
  (`hermes_state_usage.py`), kept live by a background coalescing writer, and Kanban worker
  sessions are already tagged with their `task_id` via `retag_kanban_worker_sessions()`
  (`hermes_cli/kanban_db_dispatch.py`). Wave 0 step 4 updated: it's a `task_runs` JOIN
  `sessions` read, not new instrumentation — see step 4 above.
- **Ian, #3:** no particular preference — a systemd user unit is used (matches an existing
  convention already present on this host, e.g. `hermes-dashboard.service`, unrelated system
  but confirms the pattern is normal here).

All decisions resolved. Kanban cards created; see below.

## Kanban board

Board `decision-hud` created, paused (`dispatch_enabled=false`, `auto_decompose_enabled=false`,
`review_dispatch_enabled=false`), project `decision-hud` bound to `~/GitHub/decision-hud`.

- Wave 0a (decision-hud repo, steps 1–4/6): `t_58ff50d2`
- Wave 0b (sidecars repo, step 5): `sidecars` board `t_ea811573` — cross-board dependency,
  not enforceable via `kanban_link`; every Wave 1/2 card below carries an explicit comment
  gating it on both `t_58ff50d2` AND `t_ea811573`.
- Wave 1a `t_b38c8ad4`, 1b `t_edfccc86`, 1c `t_de3f7ed0`, 1d `t_35608f11`
- Wave 2a `t_afe93c2b`, 2b `t_20f37bde`, 2c `t_be340af2`, 2d `t_cb503abe` (also gated on 1d)
- Wave 3 `t_bec362a3` (gated on all 8 Wave 1/2 cards)
