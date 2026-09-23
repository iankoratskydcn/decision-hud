# Cost-Data Coverage & First-Class Cost Metric — Implementation Plan

Status: **planning only, no code changed**. Root cause confirmed by direct
query against the live Kanban SQLite DB (`~/.hermes/kanban.db`), the Hermes
session state DB (`~/.hermes/state.db`, `session_model_usage` /
`sessions` tables), and by reading `agent_metrics_snapshot.py`, `plugin.js`,
and `backend/agent_telemetry/dashboard/comparison.py`.

---

## 1. Root cause of `cost_status='unavailable'`

Traced all 95 Kanban task rows (399 total tasks; 95 carry a non-null
`session_id`) that link a Kanban task to a Hermes agent session, deduped to
20 distinct session IDs actually referenced by `task_runs`. Two independent,
additive gaps — not one:

### Gap A — session linkage loss (the bigger one): 13 of 20 sessions (65%)
`tasks.session_id` points at a session ID that **does not exist at all** in
`state.db`'s `sessions` table — not "usage row missing", the whole session
record is gone. All 13 are worktree/scratch Kanban worker runs from Sep
15–18, spanning `default`, `architecture-builder`, `security-engineer`,
`decision-board`, `gui-builder`, `builder`, `reviewer` assignees — no single
assignee/profile is the culprit, so this isn't a profile-specific config
bug. Two live hypotheses, not yet distinguished without a Hermes-side trace
(out of scope for this repo's read-only Postgres/SQLite access):
  - **Session retention/pruning**: `state.db` is 1.67GB; old session rows
    may be pruned/archived out from under a Kanban task that still holds a
    stale `session_id` foreign-key-shaped string with no enforced FK
    (`sessions` has no size cap visible from this DB alone — needs a
    hermes-agent-side check of any retention job).
  - **Linkage never written**: the worker subprocess's `HERMES_SESSION_ID`
    env var (set by `kanban_db_dispatch.py`, confirmed via
    `HERMES_SESSION_SOURCE=kanban` at line ~3151) started a session whose ID
    was *generated late* or *changed* (e.g. sub-session/fork, retry-with-new-
    session) after the Kanban `tasks.session_id` column was already stamped
    — so the ID kanban.db recorded was never the ID the model usage got
    logged under.

  This needs one more piece of evidence this repo can't produce alone: pull
  the hermes-agent-side session lifecycle/retention code
  (`hermes_state_repair.py`, `session_lost_and_found.py`,
  `session_recovery.py` all exist in `~/hermes-agent` and are named exactly
  for this class of problem) to confirm which of the two it is before
  committing to a fix.

### Gap B — real usage rows with zero cost: 1 of remaining 7 sessions, but this is the dominant volume-weighted issue
Of the 7 sessions that DO have `session_model_usage` rows, cost is known for
5 (all `billing_provider='anthropic'`, cost > 0) and unknown for the rest.
Zooming out to the **whole state.db**, not just the Kanban-linked subset,
confirms this is systemic, not a Kanban-specific bug:

```
billing_provider  billing_mode           rows   has_cost
openai-codex      subscription_included  5205   0        <- ALL zero
openai-codex      (blank)                4527   0        <- ALL zero
anthropic         (blank)                1966   1965     <- effectively all populated
anthropic         subscription_included  27     27
```

**`openai-codex` sessions never get a cost value written — not "sometimes
missing", literally 0 of 9,732 rows (>60% of all usage rows in the DB) have
`actual_cost_usd` or `estimated_cost_usd` populated.** This is the dominant
cost-coverage gap by volume, bigger than the linkage gap. `cost_status` for
these rows is `NULL` or `'included'` and `cost_source='openai-codex'`,
meaning the recording path (`agent/codex_runtime.py`,
`_record_codex_app_server_usage`) tags the usage row but the cost estimator
(`agent.usage_pricing.estimate_usage_cost`, confirmed imported in
`codex_runtime.py`) either isn't invoked for Codex subscription-included
calls, or returns a status that the pricing table doesn't have rates for
under `subscription_included` billing mode. Since the real Bellini board
uses Codex-backed assignees for a large share of its worker profiles, this
alone explains most of `cost_status='unavailable'` buckets even where
linkage (Gap A) is fine.

### Bucket-level consequence in `agent_metrics_snapshot.py`
The `cost_known < bucket['volume']` → `'partial'`, `cost_known == 0` →
`'unavailable'` logic (lines 116–121) is correct and requires no change —
it's accurately reporting the two upstream gaps. **The bug is not in this
repo's aggregation code; it's upstream, in hermes-agent's session linkage
and Codex cost-recording paths.**

### Ranking (impact × fixability)
1. **Codex cost-recording gap (Gap B)** — highest volume impact (>60% of
   usage rows DB-wide), single well-known code path
   (`agent/codex_runtime.py` + `agent/usage_pricing.py`), fixable without
   touching the Kanban↔session linkage at all. **Fix first.**
2. **Session linkage loss (Gap A)** — smaller volume (13/20 = 65% of
   *Kanban-linked* sessions but a small absolute count of sessions), needs
   one more diagnostic step in hermes-agent before a fix can even be scoped
   (retention job vs. late-session-id-generation are different fixes).
   **Diagnose next, fix second.**

---

## 2. Fix plan

### 2.1 Gap B fix — Codex subscription cost estimation (hermes-agent repo, not decision-hud)
- Locate `agent/usage_pricing.py::estimate_usage_cost` and confirm whether
  it has a rate table entry for Codex `subscription_included` billing mode.
  If Codex subscription plans have no metered per-token rate (plausible —
  "subscription_included" literally means the token cost is bundled into a
  flat subscription fee, so a per-call USD figure may be definitionally
  unavailable, not a bug), the correct fix is **not** to fabricate a
  per-call dollar cost. Two legitimate outcomes, pick based on what
  `estimate_usage_cost` actually does today:
  - If it silently returns `None`/0 without setting `cost_status`, fix it to
    set `cost_status='included'` (a status telemetry.v1 columns already
    contain — 50 rows use it — model usage percentage-of-context or
    call-count "cost" could later be substituted, but that's a v2 concern,
    not a blocking fix here).
  - If a real per-token conversion IS possible (e.g. Codex publishes a
    notional per-token equivalent rate for subscription usage, as OpenAI
    does for some plans), wire that rate in and let `actual_cost_usd`
    populate normally.
- Either way, this is a **hermes-agent-side change**, not a decision-hud
  change: decision-hud only reads `session_model_usage`, it must not
  duplicate pricing logic. Flag to the owner as a cross-repo dependency;
  decision-hud's own fix here is limited to (2.3) below — making
  `cost_status='included'` (once real) a distinct, correctly-labeled bucket
  instead of collapsing into `'unavailable'`.

### 2.2 Gap A fix — session linkage (hermes-agent repo, needs diagnosis first)
- One-time diagnostic: pick 2–3 of the 13 orphaned session IDs, grep
  hermes-agent logs/session archive location for that exact ID to see
  whether it was ever created (proves late-ID-generation) or was created
  and later deleted (proves retention pruning).
- If **retention pruning**: either (a) exempt Kanban-worker-sourced sessions
  from the retention job (tag via `HERMES_SESSION_SOURCE=kanban`, which is
  already set — cheap filter), or (b) accept the loss and instead persist
  `session_model_usage`'s cost total into `kanban.db.tasks` (or a small
  sidecar table) at task-completion time, before the session ages out — this
  is the YAGNI-preferred fix since it needs zero change to session
  retention policy elsewhere in hermes-agent and keeps decision-hud's read
  path unchanged (still `SUM(...) GROUP BY session_id`, just against a
  pre-materialized cost instead of a live join that can lose its target).
- If **late session-id generation**: fix `kanban_db_dispatch.py` to update
  `tasks.session_id` (or an additive `tasks.session_id_resolved` column) to
  the *actual* session ID after the worker subprocess starts, not the ID
  pre-computed before spawn — a small, well-scoped change but must go
  through the Kanban-worker-spawn owner (kanban_db_dispatch.py is dense,
  ~3000+ lines, high blast-radius file).
- **Ponytail note**: do not build a generic "session reconciliation" system
  for this. Whichever of the two causes it is, the fix is a single targeted
  change (retention exemption or ID-capture timing) — no new
  reconciliation job, no background sweep, no new table beyond the minimal
  cost-snapshot option in (a) above, and only if retention pruning is
  confirmed as the cause.

### 2.3 decision-hud-side follow-up once upstream data improves
- No aggregation logic change needed in `agent_metrics_snapshot.py` — it
  already does the right thing given correct upstream data.
- Add a fourth `cost_status` value, `'included'` (bundled-subscription, no
  metered $ figure — legitimately different from `'unavailable'`, which
  means "we don't know", vs `'included'` meaning "we know it's non-metered").
  Small, additive change to the three-way branch at lines 116–121 once (2.1)
  lands upstream. Skip until upstream sets `cost_status='included'` on
  actual rows — no point adding a branch nothing will ever hit yet.

---

## 3. Exposing `cost_usd` as a selectable Agent Matrix widget metric

### Current state (verified, not assumed)
- `agent_metrics_snapshot.py` **does** emit `cost_status` and `cost_usd` on
  every record today (confirmed at lines 122–129) — this part already
  works and needs no backend change.
- `backend/tests/test_agent_metrics_snapshot.py` asserts exactly this shape
  (`cost_status`, `cost_usd` on both the known and unavailable case).
- `test/agent-metrics-widgets-crossfilter.test.mjs`'s sample fixture data
  also carries both fields on every row.
- **But grep across all of `plugin.js` for `cost_status`/`cost_usd` returns
  zero matches.** None of the six widgets under `AgentMetricsWidgetsBody`
  (heatmap, scatter, parallel-coordinates, treemap, radar, sankey) read,
  render, or filter on cost today. The data has been flowing to the
  frontend, unused, since whichever wave added `cost_status`/`cost_usd` to
  the snapshot. This is exactly the "owner suspects it's not getting used"
  signal, confirmed for the widgets layer specifically (separate from the
  Comparison Panel addressed in §4).

### Recommended approach (smallest fix, ladder rung 2: reuse existing structure)
Cost is already a per-record scalar with a status flag — same shape as
`avg_duration_s`, which the Scatter and Parallel-Coordinates widgets already
plot as an axis. Do **not** build a new "Cost" widget/chart type; wire the
existing `cost_usd` field into the metrics these widgets already support as
selectable axes/dimensions:
- **Scatter**: add `cost_usd` as a selectable Y-axis option alongside
  `avg_duration_s` (it's a volume-vs-metric scatter already; cost-vs-volume
  is the same shape).
- **Parallel Coordinates**: add `cost_usd` as a fifth axis alongside
  assignee/outcome/volume/duration — this widget is explicitly designed for
  N-axis comparison, cost is a natural fit with zero new chart logic.
- **Treemap**: treemap currently sizes segments by `volume`; add a toggle to
  size by `cost_usd` instead (same rendering code, different accessor) —
  answers "which assignee/outcome bucket costs the most" directly.
- **Heatmap / Radar / Sankey**: leave untouched. Heatmap and Radar are
  volume/outcome-shape metrics where cost doesn't add a meaningful second
  dimension without redesigning the chart; Sankey is handoff-flow, no cost
  semantics apply. Forcing cost into all six widgets for consistency would
  be exactly the kind of unrequested-abstraction/completionism ponytail
  flags — three widgets get it because it's a real question for those
  three, not "all six, for symmetry."
- Every value display must render `cost_status` alongside the number — a
  `'partial'` cost is a lower bound, not a total, and a user relying on
  `cost_usd` for real decisions needs that caveat visible at the point of
  reading, not buried in a tooltip footnote. `'unavailable'` buckets should
  render as an explicit "no cost data" state, not a $0 slice (already true
  server-side — `cost_usd: null` — just needs the widget to not coerce null
  to 0 on render).
- Do this **after** §2's fixes land, or the widget will spend its first
  weeks displaying mostly-`unavailable`/`partial` cost for exactly the
  reason diagnosed in §1 — shipping the widget first would surface a
  data-quality problem as a UI bug and cost credibility. Sequencing:
  land 2.1 (Codex cost path) → confirm coverage improves via the same
  query technique used in this investigation → wire widgets.

---

## 4. Comparison Panel ("Cost/Quality/Speed") placement recommendation

### What it actually is (verified)
- `backend/agent_telemetry/dashboard/comparison.py`: joins Postgres
  `telemetry_snapshots` rows by `producer` (`'kanban-sync'` vs
  `'sidecars'`), normalizes both onto one `ComparisonRow` shape, derives
  net token savings / avoidance rate / latency delta / quality retention.
  Two genuinely different cost bases (API $ vs. local-compute
  energy-Wh-to-$-at-residential-rate) are never blended into one number —
  confirmed by the module docstring and `ComparisonRow` having no cost
  field at all, only tokens/latency/quality. **Cost itself is not even in
  this comparison today** — it compares token/latency/quality, not $.
- It IS already wired as its own top-level nav entry (`'Cost/Quality/Speed'`,
  order 47) — separate from `'Agent Matrix'` (order 44, the combined
  dashboard+widgets page from Wave 3).
- Postgres-side, `telemetry_snapshots` currently holds only 2 rows total in
  this live instance (`p_synctest_1790109243` test-project scope, one
  `reviewer` and one `builder` agent_id) — i.e. **it is essentially unused
  in production right now**, not because it's hidden, but because almost
  nothing is producing `producer='sidecars'` or `producer='kanban-sync'`
  rows into Postgres yet. This matches the owner's "seemingly underused"
  read exactly — the underuse is a data-population gap, not a nav-placement
  gap.

### Recommendation: keep it a separate top-level page — do NOT fold into Agent Dashboard
Reasoning, not just options:
1. **Scope mismatch is real and load-bearing, not incidental.** Agent
   Matrix/Dashboard is explicitly project-scoped (`useProjectDashboardScope()`,
   `project_id` query param) — the existing code comment at plugin.js
   line ~1130 already documents that the widgets snapshot is deliberately
   *not* project-filtered because folding an unscoped source into a scoped
   page risks "silently (and incorrectly) filtered" data, and the team
   already chose to keep the widgets section unfiltered rather than fake a
   scope. Comparison Panel is unscoped by *design* (it spans all Kanban
   projects to compare against sidecar runs) — forcing it under the
   project selector would either (a) silently drop sidecar rows that have
   no project_id, wrongly implying no comparison data exists, or (b) need a
   second, disconnected "ignore the page-level project filter" carve-out
   inside the combined page, which is worse UX than a separate page with
   its own obvious un-scoped framing.
2. **The metrics are categorically different**, not just differently
   sourced. Agent Matrix/Dashboard measures volume/duration/(soon cost) per
   Kanban assignee×outcome. Comparison Panel measures token-savings/
   avoidance-rate/latency-delta/quality-retention *between two competing
   execution strategies* (delegate-to-API-agent vs. run-locally-via-sidecar).
   That's an "is it worth doing this locally" strategic question, a
   different mental mode than "which Kanban worker is expensive" — mixing
   them on one page under one nav entry would bury a strategic-tradeoff
   view inside an operational-monitoring view, actively reducing
   discoverability rather than improving it, despite the owner's stated
   underuse concern.
3. **The real fix for "underused" is upstream, same shape as §1.** Folding a
   near-empty read-model into a busier page would make it *look* used
   without it actually having data — cosmetic, not a real fix, and exactly
   the kind of thing ponytail flags as smuggled complexity dressed as a
   simplification. The two-row Postgres count means the actual blocker is
   that nothing is writing `producer='sidecars'`/`'kanban-sync'` telemetry
   snapshots into Postgres at meaningful volume yet — that's a data-pipeline
   gap in whatever writes `telemetry_snapshots` (out of this task's traced
   scope; flag as a separate follow-up investigation, not fixed by any nav
   change).
4. **What IS worth doing, cheaply, without a page merge:** promote its nav
   order (currently 47, after Agent Matrix at 44 and Decision HUD at 40) if
   the owner wants it more visible, and/or add a one-line summary/link
   card ("N sidecar comparisons available — Cost/Quality/Speed →") to the
   Agent Dashboard combined page's existing `Separator`-delimited section
   pattern (same pattern already used to stack read-model + Agent Matrix
   without merging their data paths at line ~1195). That's a discoverability
   nudge, not a scope-breaking merge, and costs one small JSX block, not a
   new page architecture.

**Bottom line: keep Comparison Panel as its own top-level nav page. Fix its
actual underuse cause (near-zero Postgres rows) as a separate data-pipeline
investigation, and optionally add a lightweight cross-link/teaser card from
Agent Dashboard rather than merging the pages.**

---

## 5. Sequencing summary

| Order | Item | Repo | Blocking? |
|---|---|---|---|
| 1 | Diagnose Gap A (retention vs late-ID) via hermes-agent session archive/logs | hermes-agent | No — informs fix choice only |
| 2 | Fix Gap B: Codex `subscription_included` cost path (`included` status or real rate) | hermes-agent | Blocks §2.3 and widget rollout quality |
| 3 | Fix Gap A per diagnosis (retention exemption, ID-capture timing, or task-side cost snapshot) | hermes-agent (+ maybe decision-hud if snapshot-at-completion chosen) | Blocks full cost coverage |
| 4 | Add `cost_status='included'` branch to `agent_metrics_snapshot.py` | decision-hud | Depends on step 2 |
| 5 | Wire `cost_usd`/`cost_status` into Scatter, Parallel-Coords, Treemap (not Heatmap/Radar/Sankey) | decision-hud (plugin.js) | Depends on steps 2–4 for data to be meaningful |
| 6 | (Optional) Bump Comparison Panel nav order / add teaser card on Agent Dashboard | decision-hud (plugin.js) | Independent, low-risk, do anytime |
| 7 | (Separate follow-up, not scoped here) Investigate why `telemetry_snapshots` has only 2 rows — what should be writing `producer='sidecars'`/`'kanban-sync'` and isn't | decision-hud + sidecars | Real fix for Comparison Panel "underuse" |

No code was modified in the course of this investigation — all findings
above came from read-only `docker exec` Postgres queries, read-only SQLite
queries against `~/.hermes/kanban.db` and `~/.hermes/state.db`, and file
reads of `agent_metrics_snapshot.py`, `plugin.js`, `comparison.py`, and both
test files.
