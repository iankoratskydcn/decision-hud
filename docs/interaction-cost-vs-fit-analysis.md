# Interaction-cost vs. fit: is card_type variety being suppressed by effort-avoidance?

## Finding: yes, there's a real (and currently invisible) mechanism for it

The fit engine (`_CARD_TYPE_RULES` / `_card_type_verdict()` in `backend-plugin/db.py`)
is purely shape-based — buckets like `mapping`, `scalar`, `categorize`,
`compare_tradeoff` — and has **no interaction-cost axis at all**. That's correct;
`docs/variety-mechanics-tie-breaking.md` explicitly protects this ("fit is decided
entirely by the deterministic discriminant rules... never a reason to relax the
discriminant rules"). Cost never contaminates correctness. Good.

But the discriminant *answers* (`card_type_answers_json`) that feed that engine
are **self-attested by the pushing agent**, not derived from the question text by
any independent check. Nothing stops (or even detects) an agent answering
`is_many_options_reduce: false` instead of `true` to land in `balance_scale`
(2-option, one click) instead of `pairwise_duel` (5+ options, a bracket) when the
real decision actually has 5 live options. The gate enforces *internal
consistency* of the bucket+answers+claimed-type triple; it cannot enforce that the
answers are *honest* about the decision. That's exactly the seam where "this
doesn't fit" bias hides — it looks like a legitimate gate pass, not a bypass.

Compounding this: `urgency` (low/normal/high) is persisted per decision but is
**never cross-referenced against card_type or its interaction cost** anywhere in
the code or docs. There is currently no way — for the agent or for Ian — to tell
"cheap card for a trivial call" (fine) apart from "cheap card for a call that
clearly warranted the rich shape" (the bias) after the fact. Nothing logs it,
nothing surfaces it, nothing audits it. That absence is the actual gap, not the
taxonomy or the gate.

## The legitimate vs. biased distinction, stated precisely

- **Legitimate**: decision is low-stakes/low-urgency and low-effort card_type is
  *also a valid fit* per the gate → picking the cheap valid option is correct
  behavior, not something to eliminate. Forcing `wire_match` on a trivial 1:1
  mapping just to "use variety" would be the opposite bug (friction for its own
  sake, explicitly banned by the "choice not action" rule).
- **Biased**: decision is high-stakes/high-urgency or the honest discriminant
  answers clearly point at a richer shape (5+ real options, multi-axis tradeoff,
  non-flat categorization) and the agent answers the discriminant questions in a
  way that steers toward the cheap sibling in the same bucket anyway. This is
  indistinguishable today from case 1 because nothing records the road not taken.

The dividing line is not "which card_type got used" — it's whether the
discriminant answers given were an honest read of the decision or a
motivated one, and whether stakes were weighed against interaction cost at all
instead of effort being minimized regardless of stakes.

## Three proposals (cheapest first, ladder-ordered)

### 1. Cost-tier × urgency audit query (no code/schema change — reuse existing columns)
`decisions.card_type` and `decisions.urgency` are already both persisted on every
push. Define a static cost-tier map (reuse the taxonomy table already in the
`decision-hud-cards` skill — one-click: `zone_select`, `quad_choice`,
`venn_overlap`; effortful: `wire_match`, `tree_placement`, `pairwise_duel`,
`spider_compare`, `2x2 Matrix`, `sort_to_bin`) as a plain Python dict, not a
schema column. Run a `SELECT card_type, urgency, COUNT(*) FROM decisions GROUP BY
1,2` and join against the tier map. A skew where `high` urgency decisions are
disproportionately resolved by cheap-tier cards (relative to their share of
`hits` at push time) is the measurable signature of effort-avoidance bias.
This needs zero new capability — it's a query over data already collected.
**Ship this first**; it tells you if the bias is real and how big, before
building anything to fix it.

### 2. Forcing-function field: rationale required only when cost and stakes disagree
Add one optional MCP param to `decision_push`: `cost_tier_rationale` (free text).
Required (soft-enforced, like the existing `card_type_bucket`/`card_type_answers`
requirement) only when both are true: `urgency == "high"` **and** the resolved
`card_type` is in the cheap tier. No new gate logic, no change to `_CARD_TYPE_RULES`
— this sits entirely outside the fit engine, exactly where
`variety-mechanics-tie-breaking.md` says cost concerns belong ("caller side, not
inside the gate itself"). Forces the agent to write down, in one line, why the
cheap shape is still right for a high-stakes call ("2 options only, richer shape
would add clicks with no information gain") — this is auditable by Ian and by a
future review pass, and it's cheap to skip honestly when the cheap card really is
correct. It does not block the push (same pattern as existing required fields);
it just stops the effort-minimizing choice from being silent.

### 3. "Cost vs. stakes" panel — extends the already-proposed Settings tab, no new mechanism
`CARD_VARIETY_VISIBILITY_PROPOSAL.md` already proposes a "Card Types" Settings
tab (#3) computed client-side from the existing decisions list. Extend that same
tab with one more cross-tab: cost-tier (cheap/medium/expensive) × urgency,
instead of a new panel. Reuses the exact same data source, same build order (1→2→3
in that doc are pure reads, no backend change), same client-side computation —
this is rung 2 of the ladder (reuse what's already speced) rather than a new
deliverable. Surfaces the pattern proposal #1's query finds, ambiently, to Ian —
so a run of "every high-urgency card resolved as zone_select" is visible without
someone remembering to run the SQL.

## Build order
1 (query, today, tells you if this is real) → 2 (rationale field, cheap guardrail
going forward) → 3 (ambient visibility, piggybacks on the existing Settings-tab
proposal). Skip 2 and 3 if #1's query shows the correlation isn't actually there
— don't build audit UI for a bias that isn't measurably happening.
