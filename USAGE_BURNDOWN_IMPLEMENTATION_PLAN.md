# Usage/Burndown Visualization Subsystem — Implementation Plan

Planning only — no code/config changed. Verified against actual files in
`decision-hud` and `hermes-agent` (paths cited throughout); nothing here is
taken on faith from the task brief.

## 0. Scope decision up front (YAGNI pass)

Owner asked for (a)-(e). Verdict per item, v1 vs phase 2:

| Item | v1? | Reasoning |
|---|---|---|
| (a) ideal-pace line vs actual cumulative spend | **Yes — load-bearing** | This IS the chart. Everything else is an annotation on top of it. |
| (b) trailing 7-day velocity projection | **Yes** | One extra derived line from data already computed for (a); cheap, owner explicitly asked, reacts faster than whole-cycle projection. |
| (c) two-sided corridor (±15%) | **Yes — load-bearing** | This is the actual owner ask ("we should see warnings... important task"). Corridor bands are two more lines derived from the same ideal-pace formula, not new data. |
| (d) P10-P90 confidence range | **Conditional** | Only render if trailing daily-spend variance clears a threshold (proposed: coefficient of variation > ~0.4 over the trailing window). Below that, a range band adds visual noise for no decision value. Compute it always (cheap — same series), decide whether to draw it per-request. This keeps v1 code simple: one code path, one boolean "band worth showing" gate, not a separate deferred feature. |
| (e) time-block-aware pacing | **Phase 2, explicit defer** | See §1.4 — no work-calendar/active-hours model exists anywhere in this stack today (verified: zero hits in `decision-hud` for "quota\|budget\|spend_cap"; `hermes-agent`'s session data has *timestamps* but nothing resembling a "work session calendar" or active-hours model). Building one is a real feature (definition of a work block, timezone handling, holidays/off days) with no existing consumer other than this chart. Calendar-day pacing is what every other burndown tool does and is legible without explanation. Recommend: ship calendar-day v1, revisit only if owner reports the calendar-day corridor gives false alarms tied to actual session gaps (e.g., corridor breach every weekend that isn't real overspend). |

Net v1 surface: **one chart type** — ideal-pace line + actual cumulative +
7-day trailing-velocity projection + ±15% corridor, with an optional P10-P90
band that self-gates on variance. One visual family, not five.

## 1. Data model

### 1.1 Two budget/quota tracks, never blended (owner's explicit requirement)

**Track A — Self-set $ budget** (e.g. $50/week)
- Does not exist anywhere today (confirmed: zero hits for quota/budget/spend_cap
  in `decision-hud`).
- Needs: a number + a cycle definition (start-of-week day, e.g. Monday 00:00
  local) + currency assumption (USD, matches `estimated_cost_usd`/
  `actual_cost_usd` already in `sessions`).
- Storage: **new decision-hud-specific settings key**, not `~/.hermes/config.yaml`.
  Reasoning: `config.yaml` is Hermes-runtime-wide config edited by the `hermes`
  CLI and other subsystems; a per-plugin UI-configured number is exactly what
  `plugin.js`'s existing `localStorage`-backed settings pattern
  (`PANE_PLACEMENT_STORAGE_KEY`, `SIDEBAR_SETTINGS_STORAGE_KEY`) already does,
  BUT a $ budget needs to be visible from both the docked pane AND the full
  Agent Dashboard page, and ideally survive across machines/browsers if the
  owner uses the dashboard from more than one desktop install. Recommendation:
  store it server-side, in decision-hud's own Postgres (`agent_telemetry`
  schema already owns durable dashboard state) as a tiny `budget_config` row
  keyed by `scope` (project or a fixed `"global"` scope), NOT in
  `~/.hermes/config.yaml`. Cross-project/global scoping question is an owner
  decision to make when this is built (does $50/week apply per-project or
  total?) — flag it, don't guess.
- Cycle: owner-defined, default weekly (Mon-Sun), stored alongside the number
  so "week" isn't hardcoded if they later want a different cadence.

**Track B — Provider-side plan quota** (Nous credits; Claude/GPT if feasible)
- **Nous**: fully wired already, just not surfaced to decision-hud. Real chain:
  `hermes_cli/nous_billing.py` (raw HTTP client to `portal.nousresearch.com`,
  handles auth/errors) → `agent/subscription_view.py`'s `CurrentSubscription`
  dataclass (`tier_id`, `tier_name`, `monthly_credits`, `credits_remaining`,
  `cycle_ends_at` ISO string, guaranteed non-null per its own docstring) →
  exposed over the TUI gateway JSON-RPC as method **`subscription.state`**
  (confirmed in `tui_gateway/server.py`'s `_LONG_HANDLERS` set, alongside
  `billing.state` which is the *payment/card* view, a different concept —
  don't conflate the two; subscription.state is the credits/plan one this
  task needs). Cycle boundary = `cycle_ends_at`, cycle start is NOT given
  directly by the API but can be derived (Nous plans appear to be monthly,
  so cycle start ≈ `cycle_ends_at` minus a month, or better: track when
  `credits_remaining` last jumped back up to `monthly_credits`, i.e. detect
  reset by delta rather than assume calendar month arithmetic — cheaper
  first cut: just use `cycle_ends_at` minus 1 calendar month unless testing
  shows drift).
- **Anthropic / OpenAI**: NOT confirmed feasible with a normal API key. Both
  vendors' usage/cost reporting APIs are documented as requiring an
  **org admin key** (Anthropic's Usage & Cost Admin API, OpenAI's
  Usage API under the Organization Owner/admin scope) — a personal API key
  used for inference calls does not carry that scope. This repo/task has not
  actually confirmed the owner holds admin-level keys for either provider.
  **Recommendation**: do not build Anthropic/OpenAI provider-quota fetching
  in v1. Ship the subsystem generically enough that a provider-quota adapter
  is a pluggable shape (see §2.3), wire ONLY Nous for v1 (it's already fully
  implemented end-to-end), and treat Anthropic/OpenAI as a phase-2 item
  gated on the owner confirming they have (or will create) admin-scoped keys
  for those providers. Do not fabricate a "quota" number from token-usage
  estimates when the real cap is unknown — that would violate this repo's
  own standing "never fabricate data" rule (see
  `AGENT_DASHBOARD_CONSOLIDATION_PLAN.md`'s Wave 3 acceptance gate language).

### 1.2 Spend series (actual $ burned, both tracks read the same series)

Already flowing: per-session `estimated_cost_usd` / `actual_cost_usd` in
`sessions` (via `hermes_state_usage.py`), joined into `telemetry_snapshots`
(`telemetry.v1` schema, `producer` field distinguishes `kanban-sync` vs
`sidecars`) by `backend/scripts/agent_metrics_snapshot.py` and
`backend/scripts/sync_kanban_telemetry.py`, synced every 15 min per cron.

For burndown math this needs to become a **point-in-time cumulative spend
series** (cumulative $ vs time, not just latest snapshot per agent as the
existing Agent Matrix widgets consume it). This is a new read-model query,
not new instrumentation:
- Query `telemetry_snapshots` (or `sessions` directly, whichever has finer
  granularity — verify at build time) for rows in `[cycle_start, now]`,
  bucketed by day (or by 15-min cron interval if finer resolution is wanted
  for the trailing-velocity calc), summed into a running total.
- Two independent queries per rendering context: one windowed to the $ budget
  cycle (owner-defined, e.g. Mon-Sun), one windowed to the provider cycle
  (`cycle_ends_at`-derived). They will usually NOT be the same window — that's
  expected and correct, not a bug to "fix" by forcing them to align.
- Compute on-the-fly per request (matches this repo's existing pattern —
  `DashboardReadModel.status()` computes fresh per request, no separate
  precomputed burndown table) UNLESS the query proves too slow at scale, in
  which case a cached/materialized daily rollup is a pure perf optimization,
  not a data-model change — defer that decision to actual latency
  measurement, don't pre-optimize.

### 1.3 Derived series (computed from 1.1 + 1.2, not stored)

All of these are pure functions of `(cumulative_spend_series, cap_or_budget,
cycle_start, cycle_end, now)` — no new storage:
- **Ideal-pace line**: linear interpolation, 0 at `cycle_start` → `cap` at
  `cycle_end`. (Owner explicitly wants this as the primary visual, not hidden
  as "just a base case" — it's the spine everything else overlays.)
- **Trailing 7-day velocity projection**: slope = (spend at `now`) - (spend
  at `now - 7d`), divided by 7, extended forward from `now` to `cycle_end`.
  Degrades gracefully to whole-cycle average if less than 7 days of history
  exist since `cycle_start` (early-cycle cold start) — flag this state
  explicitly in the payload (`trailing_window_days_actual: N`) so the UI can
  show "based on 3 days" instead of silently pretending it's a full week.
- **Corridor bands**: `ideal_pace * (1 ± 0.15)` — two more lines from the same
  formula as the ideal-pace line, zero new data.
- **P10-P90 range** (conditional on variance gate, §0): bootstrap or
  parametric estimate from daily-spend variance in the trailing window,
  projected forward with widening uncertainty toward `cycle_end` (classic
  fan-chart shape). Needs a variance-worth-showing threshold computed
  alongside it (proposed CoV > 0.4, tune once real data exists).
- **Corridor-breach state**: `over` | `under` | `on_pace`, evaluated at `now`
  only (not a historical series) — this is what alerting reads (§4).

### 1.4 Time-block-aware pacing — investigated, deferred

Searched `hermes-agent` for any existing "active hours" / "work calendar" /
session-block model that this could piggyback on. Found: `sessions` table has
per-session start/end timestamps (raw activity data), but nothing that
already models "work blocks" as a first-class concept, no holiday/off-day
calendar, no active-hours config. Building this from scratch means defining:
what counts as a work block boundary (gap-based heuristic? explicit
clock-in/out?), timezone handling, and a UI for the owner to correct
misclassified blocks — a real feature with its own edge cases, not a
free add-on to the burndown chart. Given calendar-day pacing is legible and
standard, and the owner's ask was conditional ("if the owner's usage follows
work sessions... investigate... propose whether this is worth building now or
deferring"), **recommend deferring**. Revisit if calendar-day corridor
breaches turn out to correlate with obvious non-work gaps (weekends, PTO)
rather than real pacing problems — that's the concrete signal that would
justify building it.

## 2. Provider quota wiring (decision-hud is a separate plugin from claude-code's TUI)

### 2.1 The three options considered

1. **Call the existing `subscription.state` JSON-RPC method** over the TUI
   gateway from decision-hud's backend.
2. **Re-implement the Nous billing HTTP call directly** in decision-hud
   (duplicate `nous_billing.py`'s portal-fetch logic).
3. Something else (e.g. have `hermes-agent` push subscription state into
   Postgres itself, decision-hud reads it passively).

### 2.2 Recommendation: **Option 1, call the existing RPC method**

Reasoning:
- The TUI gateway JSON-RPC surface (`tui_gateway/server.py`) is already the
  sanctioned cross-process interface for exactly this kind of "another Hermes
  surface wants billing state" need — it exists BECAUSE billing/subscription
  data needs to reach multiple UIs (CLI, TUI, presumably desktop) without each
  one re-implementing portal auth and HTTP parsing.
- Re-implementing the HTTP call (option 2) duplicates real complexity that's
  already handled correctly: `nous_billing.py`'s typed error hierarchy
  (`BillingRateLimited`, `BillingStripeUnavailable`, `BillingScopeRequired`,
  etc.), decimal-string money parsing discipline (`parse_money`/
  `format_money` in `agent/billing_view.py`), and auth-token resolution.
  Decision-hud's backend would need to re-solve "where does the Nous auth
  token live" independently, which is a real foot-gun (stale/duplicated
  credential handling).
- Option 3 (push-based) inverts a plugin/runtime relationship that doesn't
  exist today — hermes-agent has no reason to know decision-hud exists, and
  making it push data to Postgres for an unrelated plugin is the wrong
  direction of coupling for what should stay a read.

### 2.3 Concrete wiring shape

- decision-hud's backend (`agent_telemetry`, Python, already talks to
  Postgres) gains a **thin RPC client** that connects to the TUI gateway's
  JSON-RPC socket/transport (need to confirm exact transport — stdio vs
  local socket — by reading `tui_gateway/server.py`'s listener setup before
  implementation) and calls `subscription.state`.
- Wrap the parsed `CurrentSubscription` fields into a small provider-quota
  adapter interface: `{provider: "nous", credits_remaining, monthly_credits,
  cycle_ends_at, fetched_at}` — deliberately generic enough that a future
  Anthropic/OpenAI admin-API adapter slots into the same shape without
  touching the burndown math, but build ONLY the Nous adapter now (§1.1).
- Cache the RPC result briefly server-side (e.g. a few minutes, matching the
  existing 15-min telemetry cron cadence order of magnitude) rather than
  calling the gateway on every dashboard page load — the gateway call is a
  portal round-trip (`DEFAULT_TIMEOUT = 15.0`s per `nous_billing.py`), not
  something to put in a tight request path.
- Fail-open per the existing convention in this exact codepath
  (`agent/billing_view.py`'s own docstring: "Fail open: ... let the surface
  degrade gracefully, never crash") — if the gateway is unreachable or the
  Nous call fails, the quota-track chart shows an explicit "quota unavailable"
  state, and the $ budget track (independent data source) keeps rendering.
  This matches decision-hud's own established pattern of explicit
  live/stale/unavailable states rather than blank-or-fake
  (`AGENT_DASHBOARD_CONSOLIDATION_PLAN.md` Wave 1b, Wave 3 gate).

## 3. Visual spec

### 3.1 Shape (one chart, words/ASCII, no SVG)

Single time-series chart, x-axis = time from `cycle_start` to `cycle_end`,
y-axis = cumulative $ spent (0 to cap).

```
 100%|cap ------------------------------------------------●  <- corridor top (dashed, +15%)
     |                                              . . .    <- P10-P90 fan (light shaded band,
     |                                         . .  ░░░░░       only drawn if variance gate passes)
     |                                    . .   ░░░░
     |                              ideal pace line (solid, thin)
  actual cumulative spend (solid, bold) ----●●●●●●
     |                        ●●●●●                 - - - -  <- trailing-7d projection (dashed,
     |                   ●●●●●                                  from "now" marker to cycle_end)
     |              ●●●●
     |         ●●●●
   0%|____●●●●________________________________________________
     cycle_start        ▲now                              cycle_end
                                                    - - - -   <- corridor bottom (dashed, -15%)
```

- **Primary line (bold, solid)**: actual cumulative spend, from `cycle_start`
  to `now`. This is the one line that's just data, no projection.
- **Ideal-pace line (thin, solid)**: straight line, always full cycle width,
  always visible — the reference spine.
- **Corridor (two thin dashed lines, ±15% around ideal-pace, band between
  them optionally tinted very faint)**: static shape, computed once per
  cycle. Breach state (§1.3) determines the color of the *primary* actual-spend
  line near `now` (e.g. normal color while inside corridor, amber/red past
  top, blue/gray past bottom) — the corridor lines themselves stay neutral so
  the "which direction is breached" signal lives on the actual-spend line's
  color/endpoint marker, not on redrawing the corridor.
- **Trailing-velocity projection (dashed, from `now` to `cycle_end`)**: single
  dashed line, distinguishable from the corridor dashes by being a different
  dash pattern or the only element extending past `now`.
- **P10-P90 fan (very light shaded band around the trailing-velocity
  projection, from `now` to `cycle_end`)**: rendered ONLY when the variance
  gate (§0/§1.3) passes; when it doesn't, that area of the chart is just the
  single dashed projection line with no band — avoids a band that's noise
  when spend is very regular (renders correctly as "nothing to show" rather
  than a fake/flat band).
- **`now` marker**: vertical thin line or single dot, separates "actual" (left)
  from "projected" (right) visually.
- **Two of these side by side** (small-multiple, NOT overlaid) for Track A ($
  budget) and Track B (provider quota) — same visual grammar, different cycle
  windows/caps, explicitly separate per owner's "never blended" requirement.
  A compact variant (sidebar) can show just ONE of the two stacked mini
  versions or a toggle between them if width is tight; full dashboard page
  shows both side by side at full size.

### 3.2 Where this lives in `plugin.js`

Recommend: **new widget, not shoehorned into the existing 6 Agent Matrix
widgets or the Comparison Panel.**

Reasoning:
- The 6 Agent Matrix widgets (heatmap, scatter, parallel coordinates,
  treemap, radar, sankey — confirmed in `AGENT_DASHBOARD_CONSOLIDATION_PLAN.md`
  "Current state") are all point-in-time cross-agent comparisons fed by
  `AGENT_METRICS_WIDGETS_ROUTE_PATH`'s snapshot endpoint. Burndown is
  fundamentally a *time-series-against-a-cap* concept with an entirely
  different data shape (cumulative series + cap + cycle), not one more
  dimension of the same snapshot. Forcing it into that widget grid would
  make the grid's shared assumptions (one snapshot, N agents) leaky.
  Read model. It's producer-tagged rows for cost/quality/speed *comparison*
  across execution paths — also not a time-series-vs-cap concept. Reusing its
  infrastructure (route pattern, `useProjectDashboardScope`) for *code
  patterns* is fine, but it should be its own component and its own route,
  not appended to `ComparisonPanelBody`.
- Do reuse the surrounding plumbing that already generalizes well:
  `useProjectDashboardScope` (board-scoped actor token, same auth pattern as
  every other panel), the `DashboardLoadingState`/`DashboardMessageState`/
  `SectionErrorBoundary` primitives, and the existing route-registration +
  REST-fetch pattern (`ComparisonPanel`'s structure is the closest template
  to copy: own route constant, own REST path constant, own validate-shape
  function, own `*PanelBody` component, wrapped the same way).

Concretely: a new `BurndownPanel` (+ `BurndownPanelBody`, + a
`validateBurndownSnapshot`) modeled directly on `ComparisonPanel`'s
structure (lines ~602-643 today), backed by a new backend route
(`/decision-hud/agent-dashboard/burndown`, sibling to `_COMPARISON_ROUTE_PATH`
and `_HISTORY_ROUTE_PATH` in `http_app.py`) returning both tracks' series +
derived lines + breach state in one payload (`schema_version:
"agent-dashboard-burndown.v1"`, same validation discipline as
`agent-dashboard-comparison.v1`).

### 3.3 Mounting in both places (sidebar + full dashboard)

`plugin.js` already has exactly the mechanism needed:
`PANE_PLACEMENT_STORAGE_KEY` / `loadPanePlacement()` /
`paneRegistrationData()` (lines ~4100-4147) generalize "docked right of chat"
vs "session-tab" placement for a *pane*, but the more directly relevant
existing pattern is that **Agent Dashboard already renders as both a docked
pane and a full workspace page from the same component tree** — the same
`BurndownPanel` component, given a `compact` prop (or simply constrained by
its container's width via CSS, matching how `ComparisonPanel`'s existing
components already just fill whatever container they're given), mounts in:
- **Decision HUD sidebar/docked pane**: one compact stacked-mini variant
  (both tracks, smaller height, corridor + primary line only — drop the
  P10-P90 fan and trailing-projection dash detail at this size if it gets
  visually cluttered under ~300px width; still show breach-state color).
- **Agent Dashboard full page**: full side-by-side two-chart variant with all
  layers (§3.1) at full detail, alongside the existing Agent Matrix widgets
  section and Comparison Panel (stacked sections on one page, per the
  consolidation plan's Wave 2a shape).

One component, one data contract, two container widths — not two
implementations to keep in sync.

## 4. Alerting

Owner said warnings are "likely an important task" but did not specify
whether corridor breach should route through Decision HUD's existing
blocker/decision system (`decision_hud` MCP tools — `decision_push`,
`problem_report`, etc.) or just render as a visual state on the chart.

**Recommendation: visual-only warning state for v1, explicitly do NOT wire
to the Decision HUD blocker/decision system yet.** Reasoning (YAGNI):
- A blocker/decision-system integration implies someone (or some automation)
  is expected to *act* on the escalation — accept it, defer it, resolve it.
  That's a meaningfully bigger commitment: it needs a decision on cadence
  (push once per breach? once per day? only on new breach transitions?),
  ownership (who resolves a "burning too fast" decision card?), and dedup
  logic (don't spam a new card every 15-min cron tick while still breached).
  None of that has been specified by the owner yet — building it now means
  guessing at all of it.
- A visual warning state (color change on the primary line + a small text
  badge near the chart, e.g. "12% over ideal pace — will exhaust ~3 days
  before reset" / "34% under ideal pace — budget under-used") is immediately
  useful, requires no new subsystem, costs nothing beyond the chart already
  being built, and is trivially expanded into a Decision HUD push later once
  the owner has seen it in practice and can specify the actual trigger
  cadence/ownership rules they want.
- This mirrors the ladder's own logic: don't build the escalation pipeline
  until the simpler visual proves the corridor math is even calibrated
  right (±15% might turn out too tight/loose in practice — tune before
  wiring anything that pages someone).

Phase 2 (explicit, not built now): once corridor math is validated against a
few real weeks of data, wire a breach-state-*transition* (not every tick) to
`decision_push` as a bounded owner decision ("burn rate is 18% over ideal
pace for Track A — reduce spend or accept the pace"), reusing the existing
Decision HUD card infrastructure rather than inventing a new one.

## 5. Summary of what to build (v1) vs explicitly deferred

**Build now:**
1. `budget_config` storage (Postgres, decision-hud's own schema) for the
   self-set $ track — number + cycle definition.
2. Cumulative-spend-series read-model query (new query against existing
   `telemetry_snapshots`/`sessions` data, no new instrumentation).
3. Nous `subscription.state` RPC client in decision-hud's backend, with
   short-lived caching and fail-open degrade.
4. Burndown derived-math module: ideal-pace, corridor, trailing-7d
   projection, conditional P10-P90 band, breach-state — pure functions over
   the series from #2/#3.
5. New backend route `/decision-hud/agent-dashboard/burndown`
   (`agent-dashboard-burndown.v1` schema, both tracks in one payload).
6. New `BurndownPanel` frontend component (modeled on `ComparisonPanel`),
   mounted in both Decision HUD docked pane and Agent Dashboard full page
   from the same component via container-width-driven compact/full variant.
7. Visual-only breach-state warning (color + text badge), no external
   alerting wiring.

**Explicitly deferred (phase 2), with the trigger condition for revisiting each:**
- Anthropic/OpenAI provider-quota tracks — revisit once owner confirms
  admin-scoped API keys exist/are obtainable for those providers.
- Time-block-aware (work-session) pacing instead of calendar-day — revisit
  if calendar-day corridor breaches visibly correlate with non-work gaps
  rather than real pacing issues.
- Decision HUD blocker/decision-system wiring for corridor breaches —
  revisit once the visual warning has run long enough to validate the ±15%
  threshold and the owner specifies breach-transition cadence/ownership.
- Precomputed/materialized daily spend rollups — revisit only if the
  on-the-fly cumulative-series query proves too slow at real data volume.

## 6. Open questions for the owner (do not guess these)

1. Self-set $ budget scope: one global number, or per-project? (affects
   `budget_config` schema — scope key or fixed `"global"`.)
2. Confirm week boundary convention for the $50/week cycle (Mon-Sun default
   assumed above — correct?).
3. Confirm whether Anthropic/OpenAI admin-scoped keys are available/wanted
   before phase 2 work on those tracks is scheduled.
