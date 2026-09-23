# Question-Framing Guide for Decision HUD Card Types

## Why this exists

The card-type gate (`card-type-gate` skill) classifies a question *after* it's
already written. If the question was written vaguely — "what should we do
about X?" — every classifier downstream is guessing, and the agent tends to
force-fit whatever card_type sounds closest instead of finding the one that
fits. The fix is upstream: **author the decision question so its natural
shape is already visible in the phrasing**, before the gate ever runs.

This doc reverse-engineers each of the 23 card_types into the question
pattern that naturally produces it, so an agent formulating a decision can
write toward a shape instead of writing vague prose and forcing it in
afterward.

## Table: card_type → ideal question-phrasing pattern

| card_type | Ideal phrasing pattern | Trigger words/structure |
|---|---|---|
| `wire_match` | "Link each `<item in set 1>` to a `<item in set 2>`." Two named sets, every left item needs exactly one right item. | "match each ... to ...", "assign ... to ...", "pair up" |
| `range_slider` | "What's the acceptable `<min>`–`<max>` band for `<metric>`?" An interval, not a point. | "range", "between X and Y", "lower/upper bound", "SLO band" |
| `constrained_budget_split` | "Split `<total>` across `<category A/B/C...>` — how much goes to each?" Independent sliders, must sum to total. | "split the budget/total across", "how much to each of" |
| `stacked_bar_split` | "What's the 3-way percentage split between `<A>`, `<B>`, `<C>`?" Visual proportion, must sum to 100%. | "% split", "proportion of", exactly 3 buckets |
| `confidence_rating` | "What's your `<value>` estimate for `<X>`, and how confident are you in it?" Two independent axes: point value + certainty. | "estimate ... and how sure", "value + confidence" |
| `scalar_slider` | "What should `<parameter>` be set to?" A single point on a true continuum. | "set the value of", "what should X be (in units)" |
| `quad_choice` | "Do you want `<A>` AND `<B>`, either, neither, or just one?" Exactly two independent yes/no factors combined. | "both/either/neither", "A and/or B" |
| `multi_select` | "Which of `<list>` apply? (any number, independently)" | "select all that apply", "which of these" |
| `zone_select` | "Which level/tier fits — `<label 1>`, `<label 2>`, `<label 3>`?" Few discrete labeled levels, exactly one. | "which tier/level", named discrete zones (not a number line) |
| `tree_placement` | "Where does `<item>` belong in `<nested category tree>`?" Non-flat hierarchy. | "which category/subcategory", nested taxonomy language |
| `matrix_2x2` | "How does each `<item>` rate on `<axis X>` vs `<axis Y>`?" Two orthogonal dimensions. | "impact vs effort", "X by Y grid" |
| `sort_to_bin` | "Sort each `<item>` into `<bin 1>`, `<bin 2>` (or `<bin 3>`)." Flat categorization, 2-3 buckets. | "sort into", "categorize as", 2-3 named buckets |
| `timeline_placement` | "When (on `<dated schedule>`) should `<item>` happen?" Absolute date/position, not just order. | "when should", "which date/milestone", real calendar/ticks |
| `sequence_order` | "What order should `<items>` happen in, relative to each other?" Rank only, no dates. | "rank", "order of priority", "which comes first" (no dates) |
| `assemble_pieces` | "For each `<slot>`, which `<option>` do you want?" Compose a whole from independently-chosen parts. | "for each of these slots, pick", "build/assemble from" |
| `balance_scale` | "Weighing `<consideration 1>` vs `<consideration 2>` vs ..., which way does `<option A>` vs `<option B>` come out?" Two options, multiple named considerations to weigh. | "weigh these factors", "which outweighs", two-option framing with a list of considerations |
| `pairwise_duel` | "Given `<5+ options>`, which do you prefer most?" Too many to rank at once, bracket down. | "which do you prefer" over a long list (5+) |
| `spider_compare` | "Compare `<option A>` vs `<option B>` across `<criteria X, Y, Z...>` — no single axis should dominate." | "compare A vs B across these criteria", 3+ named axes, explicitly multi-dimensional |
| `venn_overlap` | "Does `<item>` belong to `<set A>` only, `<set B>` only, both, or neither?" | "shared vs exclusive", "overlap between A and B" |
| `anchor_adjust` | "Here are recommended defaults for `<fields>` — override any you disagree with." Every field has a safe pre-filled default. | "recommended settings, adjust as needed", "defaults you can override" |
| `mode_radial_gauge` | "Pick a `<mode>`; see how it affects `<gauge value>`." One choice reconfigures a read-only display. | "select a mode to see its effect on", controller + view pairing |
| `context_readout` | Not a question — a statement of fact/context: "`<metric>` is currently `<value>`, trending `<delta>`." No decision embedded. | "for context,", "FYI current state is", no actual choice implied |
| `mcq_context` (fallback) | Anything that doesn't cleanly match another shape, or is a simple single pick from options. | plain "which of these options" with no other structural signal |

## Pre-classification framing checklist

Run this **while drafting the question**, before invoking the card-type
gate. If you can answer these from the underlying decision, write the
question so the answer is stated directly in its phrasing — don't write a
vague question and hope the gate infers it.

1. **How many "things" are actually being decided?** One value → scalar
   family. A set of items each needing a choice → mapping/categorize/compose
   family. Two options being weighed → compare family.
2. **Is there a total that must be preserved?** (100%, a budget, a fixed
   count) → split family (`constrained_budget_split` / `stacked_bar_split`).
   If no fixed total, it's not a split card.
3. **Is the answer a point, an interval, or a discrete label?** Point on a
   continuum → `scalar_slider`. Point + confidence → `confidence_rating`.
   Min/max band → `range_slider`. Discrete label → `zone_select`.
4. **Are two sets being connected, or one set being placed into structure?**
   Set-to-set → `wire_match`. Set into flat bins → `sort_to_bin`. Set into a
   nested tree → `tree_placement`. Set into a 2D grid → `matrix_2x2`.
5. **Is order or date being asked, or just membership/category?** Relative
   order → `sequence_order`. Actual date/position on a schedule →
   `timeline_placement`.
6. **How many options, and is it a straight comparison or a multi-criteria
   one?** Exactly 2 options, weighing named considerations → `balance_scale`.
   Exactly 2 options, 3+ *comparison axes*, no axis should win outright →
   `spider_compare`. 5+ options needing a single winner → `pairwise_duel`.
7. **Does membership overlap?** "A-only / B-only / both / neither" language →
   `venn_overlap`. "Both AND/OR/NEITHER of two factors" (not sets, just two
   yes/no conditions) → `quad_choice`.
8. **Are safe defaults known for every field?** If yes and the user should be
   able to zero-click-confirm → `anchor_adjust`. If every slot needs an
   active pick with no safe default → `assemble_pieces`.
9. **Is this actually informing another decision, not itself a choice?** →
   `context_readout` — don't dress up a status update as a question.
10. **If none of the above resolved cleanly** — don't force it. Fall back to
    `mcq_context` (or a plain `card_type=None` list). `no_match` is a valid,
    correct outcome, not a failure state to paper over with the
    nearest-sounding card.

The test for "is this framed well": read the question text alone, with no
knowledge of the 23 card types — can you already tell what shape of answer
it wants (a point? an interval? a set of pairs? an ordering?) just from how
it's worded? If not, rewrite the question before running the gate.
