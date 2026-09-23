# Decision HUD Card Variety — Synthesis (20-agent creative audit)

19 subagents examined the 23-card deck from philosophical, aesthetic, empirical,
game-design, UX, and systems-safety angles. This is the consolidated read. Source
docs are all in `docs/` and repo root (listed at bottom).

## The one finding that matters most: this isn't (only) a taste problem, it's a bug

The empirical audit (`docs/` history pull, 27 real pushes) found:

- **`quad_choice` is 10/10 force-fit onto plain yes/no approvals** — 37% of all
  pushes are a binary decision wearing a 4-cell AND/OR/NEITHER grid it never uses.
- **`sequence_order` is broken in both real uses** — items went into
  `card_payload.items` instead of `choices`, which is what `SequenceOrderCard`
  actually reads. Both rendered as broken 2-row lists, silently.
- **`range_slider` used the wrong default keys** (`default_min/max` instead of
  `default_low/high`) — silently opened full-range instead of the intended band.
- **13 of 23 card types (57%) have never been used at all.**

So: part of "I rarely see them all" is literal — the agent gravitates to one
familiar shape, and even when it reaches for a "richer" one, it sometimes gets the
payload contract wrong and you never see it working correctly. Fix the bugs before
tuning variety-seeking behavior, or you'll be adding variety to broken renders.

## Why this happens (philosophical framing)

Variety is a population statistic; fit is a per-decision property. The gate
(`card_type_selector.py`) is a pure function — it can't be habituated, only fed
biased inputs. The failure lives upstream: the agent's bucket/discriminant
*answers* are self-attested with no check, so it can reverse-engineer answers
toward whatever shape it already reached for (typically the cheapest: `mcq_context`,
`multi_select`, `scalar_slider`, `quad_choice`-as-yes/no). **Chasing variety
directly is Goodhart's law** — an agent told "use more types" will bend answers
toward novelty instead of toward comfort, which is the same failure inverted. Fit
must always come first; variety is only a valid *diagnostic*, never a push-time
target.

## Recommended action, in priority order

### 1. Fix the two real defects (do this first, it's just correctness)
- `sequence_order`: rankable items belong in `choices`, not `card_payload.items`.
- `range_slider`: payload keys are `default_low`/`default_high`, not `default_min`/`default_max`.
- Both pitfalls are *already documented* in the `decision-hud-cards` skill — the
  bug is that pushes weren't checked against it. Add a cheap pre-push lint (grep
  the payload keys against the renderer's documented contract) rather than trusting
  memory each time.

### 2. Stop force-fitting quad_choice onto binary approvals
Binary approve/reject is `mcq_context` (or a 2-zone `zone_select` if you want a
richer look), never `quad_choice` — that card is for real AND/OR/NEITHER logic
across two independent factors. This single habit is responsible for over a third
of all pushes being the same wrong shape.

### 3. Adopt the pre-push ritual (`docs/pre-push-ritual.md`)
8 steps, feels like ~5 on trivial decisions: draft two competing question
framings before classifying, explicitly ask "best fit or first one that passed?",
glance at underused types as a catch — not a quota — then run the real gate and
trust it. Also explicitly checks the opposite failure (picking a rare card for
novelty, not fit).

### 4. Frame the question before classifying, not after
`docs/question-framing-guide.md` reverse-engineers each of the 23 card types into
its ideal question-phrasing pattern (e.g. wire_match ↔ "link each X to a Y").
Writing the decision question in shape-revealing language *first* means the gate
sees a real signal instead of a vague question force-classified after the fact.

### 5. Use the domain playbook as a precedent library
`docs/domain-decision-playbook.md` maps ~30 decisions Ian actually faces (Bellini
CMS/Canvas, TBCAF, Shattered Flames, Kanban orchestration, general dev) to their
best-fit card type, covering all 23 types with grounded, non-padded examples. Pattern-match
future decisions against this instead of reclassifying from scratch.

### 6. Only ever let statistics break genuine ties, never override a resolved match
The gate is provably near-fully-partitioned per bucket (`ambiguous` should rarely
fire). When it does: prefer least-recently-used tied option → then interaction
cost vs. urgency → then ask Ian, in that order
(`CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md`, `docs/variety-mechanics-tie-breaking.md`).
**Never** let usage stats or novelty-seeking touch a `status == "resolved"`
single-match verdict — that's the one hard line every proposal respects.

### 7. Give Ian passive visibility (no agent prompting required)
`CARD_VARIETY_VISIBILITY_PROPOSAL.md`: card-type badge on each card header, a
"14/23 types used (last 20)" strip in the queue header, and a new "Card Types"
Settings tab with a usage histogram — all client-side reuse of data already
fetched, no backend change, ranked cheapest-first.

### 8. Respect what's structurally rare vs. what's a real gap
`venn_overlap`, `mode_radial_gauge`, `tree_placement`, `pairwise_duel`, `wire_match`,
`stacked_bar_split` are legitimately rare in a solo webmaster's actual decision
mix — don't chase usage parity for these, that IS forcing bad fits. But
`anchor_adjust`, `sort_to_bin`, `matrix_2x2`, `confidence_rating`,
`constrained_budget_split` are common shapes in Ian's actual work (config
defaults, backlog triage, impact/effort calls, budget/time splits) and being
unused there is a genuine gap worth fixing.

### 9. Decompose complex/fuzzy decisions instead of force-fitting one card
Two patterns, both grounded, neither requiring new infra:
- **Sidecar decomposition attempted, not currently usable** — `sidecar_dispatch`'s
  `request_decomposition` op returns `unsupported` in this environment (tested
  live). Use plain agent-side reasoning to split instead.
- **Manual split workflow** (`docs/decision-decomposition-workflow.md`): detect
  fan-out, split into single-shaped sub-decisions, run the gate per sub-decision,
  push each separately, reassemble via existing `decision_list`/`decision_check`.
  Worked example: an $18k budget split + a 6-candidate hire pick + a go-live date
  → `stacked_bar_split` + `pairwise_duel` + `timeline_placement`, each independently
  gate-verified.
- **Wizard chains** (`docs/proposals/decision-wizard-chains.md`) for the rarer
  case where sub-decisions genuinely *depend* on each other's resolved value
  (e.g. a `scalar_slider` TTL pick seeding an `anchor_adjust`'s defaults) — capped
  at 3 steps, nested inside existing `card_payload_json`, no schema change.

### 10. Don't break Kanban blocker routing or Rule-1 batch approval
`docs/variety-mechanism-compatibility-guardrails.md` + prior-art review: blocker
routing *deliberately* uses plain fast `mcq_context` for owner decisions, by
design, to keep the critical path deterministic and LLM-classifier-free — any
variety push must not force richer cards onto that path. `card_type ==
'batch_approval'`/`'missing_constraint'` and the `_kanban_*`/`contract_version`
payload keys are load-bearing and must stay frozen/opaque to any new logic. New
columns: additive/nullable only.

### 11. Consumption side was already fine — just undocumented
Every renderer already writes a real human-readable digest into `resolved_choice`
regardless of card richness (e.g. spider_compare resolves to `"Postgres wins 4 of
5 axes, 1 tie"`). Agents consuming decisions never need to hand-parse
`resolved_payload` unless they want the structured detail. Document "read
resolved_choice first" — this alone may remove a real (if invisible) incentive to
avoid richer cards. See `CONSUMPTION_SIDE_FRICTION_PROPOSAL.md`.

### 12. Make the rich/rare cards worth reaching for (aesthetic polish, deferred)
`docs/` visual-craft pass: CSS/SVG-only animation ideas for pairwise_duel
(bracket ladder + champion reveal), spider_compare (radar builds itself
axis-by-axis), venn_overlap (regions light up on hover), mode_radial_gauge
(needle sweep + threshold color), timeline_placement (tick ceremony),
wire_match (bezier lines draw in). All within the existing renderer contract,
zero new dependencies, zero new interaction modes — polish, not scope creep.
Do this last; it's about delight, not the actual bug.

## What NOT to do (every agent converged on this)
- Never let usage-frequency/novelty logic override a `resolved` single-match
  verdict from the deterministic gate. Fit wins, always.
- Don't build a scoring/ranking system that nudges toward *specific* underused
  card types by desirability — that's the Goodhart trap in a different shape.
- Don't force richer card types onto the Kanban blocker-routing critical path.
- Don't build a new decomposition tool, DAG field, or rollup mechanism — encode
  ordering in question text / existing `decision_list` polling.
- Don't build a generic cross-card-type payload flattener — the shapes are
  genuinely different; that hides structure agents sometimes need.

## Source documents (this session)
`docs/curation-proposals.md`, `docs/telemetry-tiebreak-entropy.md`,
`docs/decision-decomposition-workflow.md`, `docs/variety-mechanics-tie-breaking.md`,
`docs/pre-push-ritual.md`, `docs/interaction-cost-vs-fit-analysis.md`,
`docs/domain-decision-playbook.md`, `docs/question-framing-guide.md`,
`docs/proposals/decision-wizard-chains.md`, `docs/card-misuse-catalog.md`,
`docs/variety-mechanism-compatibility-guardrails.md`,
`CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md`, `CARD_VARIETY_VISIBILITY_PROPOSAL.md`,
`CONSUMPTION_SIDE_FRICTION_PROPOSAL.md`.
