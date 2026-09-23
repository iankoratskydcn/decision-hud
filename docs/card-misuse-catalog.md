# Decision HUD Card Misuse Catalog

Smell-test before pushing a card: if your question resembles the misfit
example below, stop and reclassify using the correct alternative.

---

**wire_match** — "Which cloud region should each of our 12 microservices deploy to?" with 6 allowed regions.
Not a 1:1 mapping — many services legitimately share one region, and the wiring visual implies exclusivity/pairing that doesn't exist here.
Correct alternative: **tree_placement** (services placed into a region category) or **assemble_pieces** if each service picks independently from the same option list.

**range_slider** — "What's the ideal cache TTL?" (a single number, not a band).
There's no min/max interval to express — it's one point on a continuum, and forcing dual handles makes the user fake a fictitious "band" around their real answer.
Correct alternative: **scalar_slider**.

**constrained_budget_split** — "Rank these 3 launch blockers by priority."
Ranking isn't a fixed-total allocation; there's no quantity to conserve, and making the user assign numbers that must sum to 100 invents fake precision for a pure ordering question.
Correct alternative: **sequence_order**.

**stacked_bar_split** — "Should we support 2, 3, or 4 auth providers at launch?"
This is picking a count/option, not visually partitioning 100% across exactly 3 named segments — there's nothing to "split."
Correct alternative: **zone_select**.

**confidence_rating** — "Pick a deployment date for the migration."
A date isn't a value-plus-certainty-band question; tacking on a "how confident are you" axis is a non-sequitur when the real need is placement on a calendar.
Correct alternative: **timeline_placement**.

**scalar_slider** — "Which of these 4 caching strategies should we use: write-through, write-back, write-around, or none?"
These are discrete named strategies with no continuum between them — sliding between "write-through" and "none" is meaningless.
Correct alternative: **zone_select**.

**quad_choice** — "Which of these 5 vendors should we shortlist?"
Quad Choice is built for exactly 2 factors combined via AND/OR/NEITHER — 5 independent vendor options blow past its 2x2 logic grid entirely.
Correct alternative: **multi_select** (shortlist = pick any subset).

**multi_select** — "Should logging be verbose, normal, or silent?"
These 3 levels are mutually exclusive settings, not an independent subset — letting someone check "verbose" and "silent" together produces a nonsense config.
Correct alternative: **zone_select**.

**zone_select** — "How should engineering effort be split between the 3 workstreams this quarter?"
Zone Select needs a single exclusive pick; effort split across 3 workstreams is an allocation problem, not a "pick one bucket" problem.
Correct alternative: **constrained_budget_split** (or **stacked_bar_split** if visual thirds suffice).

**tree_placement** — "Approve or reject this PR?"
A nested category tree is wildly overbuilt for a flat binary — there's no hierarchy to place anything into.
Correct alternative: **mcq_context** (plain 2-choice MCQ).

**matrix_2x2** — "Which of these 6 features should we build first?"
Impact×effort scoring implies each feature needs *two* independent judgments before placement, but if the real question is just "give me a priority order," the matrix adds a dimension nobody asked for.
Correct alternative: **sequence_order** (or **matrix_2x2** only if effort AND impact are both genuinely being assessed).

**sort_to_bin** — "Categorize these 15 support tickets into product area: billing, auth, search, notifications, or export."
Sort-to-Bin caps at 2-3 buckets; 5 categories breaks its flat-bucket assumption and turns the UI into a scroll-and-guess exercise.
Correct alternative: **tree_placement** (or **assemble_pieces** per-item if categories don't nest).

**timeline_placement** — "Should we ship the redesign before or after the pricing change?"
This is relative ordering of 2 events, not a placement on an absolute dated schedule — no calendar date is actually being decided.
Correct alternative: **sequence_order**.

**sequence_order** — "When exactly should each of these 4 features ship?" (real target dates needed for a roadmap).
Sequence Order only captures relative rank; if downstream planning needs actual dates (not just "before/after"), rank alone silently discards the information needed.
Correct alternative: **timeline_placement**.

**assemble_pieces** — "Which 3 of these 8 integration partners should we support?"
Assemble Pieces is one-choice-per-named-slot composition; there are no fixed "slots" here, just an open subset pick from a pool.
Correct alternative: **multi_select**.

**balance_scale** — "Choose our primary cloud provider: AWS, GCP, or Azure."
Balance Scale is strictly 2-option weighing; a 3-way vendor choice has no "scale" to tip and forcing 3 options onto 2 pans loses one candidate.
Correct alternative: **pairwise_duel** (or **mcq_context** for a simple flat pick).

**pairwise_duel** — "Should we enable dark mode by default: yes or no?"
Running a single-elimination bracket over 2 options is theater — there's no reduction happening, just one binary click dressed up as a tournament.
Correct alternative: **mcq_context** (or **balance_scale** if there are real tradeoffs to weigh, not just yes/no).

**spider_compare** — "Is Option A cheaper than Option B?"
Spider Compare exists for multi-axis tradeoffs with no dominant axis; a single clearly-dominant cost question doesn't need a radar chart, it needs an answer.
Correct alternative: **mcq_context** (or **balance_scale** if cost is one of several considerations).

**venn_overlap** — "Which of these 3 teams (Platform, Growth, Infra) should own this incident?"
Venn Overlap models shared-vs-exclusive membership between exactly 2 sets; 3 non-overlapping team options aren't a membership question at all.
Correct alternative: **zone_select**.

**anchor_adjust** — "Pick a name for the new internal tool."
Anchor & Adjust assumes a safe recommended default the user can rubber-stamp; a naming decision has no "safe default" worth pre-filling, so the zero-click confirm just launders a real open question as trivial.
Correct alternative: **mcq_context** with free text, or plain `clarify`.

**mode_radial_gauge** — "How many retries should the API client attempt?"
This is a single settable value, not a mode picker driving a *view-only* gauge fed by some other reactive config — there's no second card whose state this should visualize.
Correct alternative: **scalar_slider**.

**context_readout** — "Should we roll back the last deploy?"
Context Readout is pure info with no confirm action; slapping a decision this consequential into a dashed-border "acknowledge and move on" widget makes a real choice disappear without ever being decided.
Correct alternative: **mcq_context** (or `clarify` given the urgency).

**mcq_context** — "Allocate the $50k infra budget across compute, storage, and networking."
Plain MCQ can't express a 3-way numeric split; falling back to "pick one of these text options" throws away the fact that this is fundamentally a quantity-allocation problem.
Correct alternative: **constrained_budget_split**.
