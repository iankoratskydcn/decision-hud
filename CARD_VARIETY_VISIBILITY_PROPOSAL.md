# Card-variety visibility for Ian (not just prompting the agent)

Confirmed via `~/.hermes/desktop-plugins/decision-hud/plugin.js`: 23 entries in
`CARD_RENDERERS` (line ~3669), but nothing in the UI surfaces which types exist
or which have actually been used. `useDecisionQueue` (line 1284) only calls
`cliExec(['decision','list',...])` / `['decision','projects'])` — no
`card_type` aggregation. `DecisionCard` (line 3769) picks a renderer silently;
no type name/badge is shown on the card itself. `SettingsFullscreen` (line
4983) has 4 tabs — Subagent Rules, Layout, Kanban Escalation, Telemetry Sync —
none show card-type stats. Ian currently has **zero passive visibility** into
variety; the only lever is prompting the agent harder.

## 1. Card-type badge on every card (per-card footer)
Smallest fix, biggest payoff. `CardHeader` (line 1398) already renders a
small-caps row (project slug badge + urgency + dismiss). Add
`decision.card_type` as a third badge there — it's already on the `decision`
object (used at line 3770 to pick the renderer), so this is a pure display
add, no new data fetch. Now every card visibly says what shape it is, so
repetition is obvious at a glance instead of requiring Ian to infer it from
the card's look.

## 2. "Deck coverage" strip in the queue header
Next to the board selector row (`mainColumn` header, ~line 5940-5947, where
`BoardSettingsPanel`/`BoardSelector`/`TriageBlockedWorkButton` already sit).
Add a compact indicator — e.g. `14/23 types used (last 20)` — computed
client-side from the already-fetched `decisions` list (or the last N resolved,
if `decision list` supports a resolved/history flag; check CLI before adding
a new command). No new backend call needed if the existing list already
carries `card_type` per row (it does, since `DecisionCard` reads it). This
is the ambient "is the agent actually varying types" signal Ian can see
without opening anything.

## 3. Card-type usage panel — new Settings tab
Add a 5th tab, "Card Types", alongside Subagent Rules / Layout / Kanban
Escalation / Telemetry Sync in `SettingsFullscreen` (nav list ~line 5018-5046,
tab-body switch ~line 5050-5062). Content: all 23 `CARD_RENDERERS` keys listed
with a usage count over the recent window (reuse the same data source as #2,
just the full un-sliced history) — makes the never-used types visible, not
just the recently-seen ones on the sparse card view. This is where a
frequency histogram belongs since it doesn't need to live in the hot path.

## 4. Manual "try a different card" action — per-card footer, deferred
Lower priority / bigger lift: a button next to Defer/Discuss (shared row,
~line 3812-3817) letting Ian re-request the same decision in a different
card_type. This needs a real backend round-trip (re-push through
`db._card_type_verdict`'s engine, per `test_card_type_enforcement.py`, since
card_type is server-verified against `card_type_bucket`/`card_type_answers`
and can't just be swapped client-side) — skip until #1-#3 show the problem is
actually about *variety* and not just *visibility*. If it turns out variety
really is bad even once Ian can see it, this is the fix; don't build it
speculatively.

## Build order
1 → 2 → 3 are all reads of data already in hand (`card_type` on each
decision row), no backend changes, no new dependencies — cheapest first.
4 needs backend engine plumbing and should wait until 1-3 prove it's needed.
