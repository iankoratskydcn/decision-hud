# Domain Decision Playbook

Grounded precedent library: for each of Ian's real recurring work domains, the
decision types he actually hits and the `card_type` (of the 23 live renderers
in `plugin.js` `CARD_RENDERERS`) that is the genuine best-fit shape — not a
generic example, not a vibe pick. Classification follows `card-type-gate`'s
discriminant logic (bucket → shape → card), never free-association off the
`decision-hud-cards` taxonomy table. When pushing one of these for real, still
run `card_type_selector.py` to get the `card_type_bucket` /
`card_type_answers_json` the backend now requires — this doc tells you which
card to expect, not a shortcut around the gate.

Use this the way `design-pattern-gate`'s "known-confusable cluster" is used:
pattern-match a new decision against the closest entry below before reasoning
from scratch.

## Bellini College (OmniCMS, Canvas LMS, Power Platform)

1. **Which page template to apply to a new subpage** (landing / profile /
   article / list — small fixed set, exclusive, no continuum) →
   **`zone_select`**.
2. **Re-homing orphaned pages during a sitemap restructure** into the site's
   nested section tree → **`tree_placement`** (non-flat category assignment).
3. **Scheduling Canvas module release dates across a semester** — absolute
   calendar positions, not just "this before that" → **`timeline_placement`**.
4. **Triaging a batch of accessibility findings** (missing alt text, contrast,
   heading order) into fix-now / fix-next-sprint / wontfix → **`sort_to_bin`**.
5. **Deciding whether two CMS sections should merge** — some pages live in
   both, some only in one → **`venn_overlap`** (shared vs. exclusive
   membership, not a ranked or split question).
6. **Prioritizing a backlog of 6+ pending Power Platform automation flows** —
   too many to hand-rank in one pass → **`pairwise_duel`** (single-elimination
   bracket surfaces the real winner without forcing a full order).
7. **Splitting a fixed redesign timeline/budget across content, template dev,
   and QA** (three buckets, must sum to 100%) → **`stacked_bar_split`**.

## TBCAF App (AWS, Cognito, Replit)

1. **Rating confidence in an incident root-cause diagnosis** ("Cognito token
   refresh is the cause" — how sure, separately from the diagnosis itself) →
   **`confidence_rating`** (value axis + independent certainty axis).
2. **Composing a new environment's stack** (region, instance size, RDS tier —
   independent slots, one choice each) → **`assemble_pieces`**.
3. **Setting autoscaling min/max instance bounds** — an interval, not a single
   number → **`range_slider`**.
4. **Choosing a deploy strategy** where blue-green and canary can combine
   (both / either / one-only / neither) → **`quad_choice`**.
5. **Selecting which breaking-change mitigations to ship** (add versioning,
   deprecation warnings, feature flag, user notice — independent, any
   subset) → **`multi_select`**.
6. **Deciding whether to migrate staging off Replit onto full AWS** — weigh
   cost, control, uptime, dev velocity against each other → **`balance_scale`**.
7. **Comparing Cognito vs. Auth0 for a new identity requirement** across cost,
   DX, migration effort, security with no single dominant axis →
   **`spider_compare`** (exactly two real options here, which the payload
   requires).

## Shattered Flames (game design, NPCs, event history)

1. **Assembling a new NPC's core template** (race, faction, role, starting
   location — independent slots) → **`assemble_pieces`**.
2. **Placing a new lore event on the game's historical timeline** at an
   absolute in-world date → **`timeline_placement`**.
3. **Pairing each companion NPC to its one assigned quest-giver** — strict 1:1
   mapping between two sets → **`wire_match`**.
4. **Plotting newly authored NPCs on a moral-alignment × power-level grid** →
   **`matrix_2x2`**.
5. **Ordering which of 4 new zones get built this milestone** — a small,
   fully-rankable set → **`sequence_order`**.
6. **Narrowing 6 competing "final villain" concepts down to one** — too many
   to rank, needs a knockout → **`pairwise_duel`**.
7. **Deciding an NPC's faction membership** when double-agent overlap is on
   the table (exclusively Faction A, exclusively B, or both) →
   **`venn_overlap`**.

## Hermes / Kanban Orchestration

1. **Setting max parallel worker concurrency on a board** — a true continuous
   scalar (1–20 agents) → **`scalar_slider`**.
2. **Triaging the backlog into now / next / icebox** → **`sort_to_bin`**.
3. **Choosing a dispatch throttle mode** (conservative / balanced /
   aggressive) whose selection re-renders a live, view-only queue-load gauge →
   **`mode_radial_gauge`**.
4. **Rating confidence in an auto-classified stalled-worker failure category**
   (which failure bucket + how sure) → **`confidence_rating`**.
5. **Allocating a fixed weekly agent-hour budget across 3 active boards** →
   **`constrained_budget_split`** (independent sliders, hard total, not a
   visual 3-segment bar).
6. **Reviewing effort-estimate-vs-actual for a completed wave** — pure
   evidence, no decision embedded → **`context_readout`**.
7. **Setting per-provider retry/backoff/timeout defaults** where sane defaults
   already exist and most rows should be left alone → **`anchor_adjust`**
   (recommend-and-override, zero-click-confirm valid).

## General Dev / Ops

1. **Bootstrapping a new repo's CI defaults** (lint level, test runner,
   branch protection) with safe recommended values, override only what's
   wrong → **`anchor_adjust`**.
2. **Deciding whether to adopt a dependency vs. write it in-house** — weigh
   maintenance burden, security surface, time-to-ship against each other →
   **`balance_scale`**.
3. **Assembling a new service's logging/monitoring stack** (log shipper,
   metrics backend, alert channel — independent per-slot choices) →
   **`assemble_pieces`**.
4. **Picking a maintenance-window slot on the deploy calendar** — an absolute
   date/time, not relative ordering → **`timeline_placement`**.
5. **A low-stakes call with no real shape** ("restart the service now or
   defer to the next window") — doesn't fit any of the 22 shaped cards →
   **`mcq_context`** (the mandatory zero-cost `none_of_these` fallback, not a
   forced fit into the nearest-sounding card).

## Coverage check

All 23 live card types are anchored to at least one real decision above
(`wire_match`, `range_slider`, `constrained_budget_split`, `stacked_bar_split`,
`confidence_rating`, `scalar_slider`, `quad_choice`, `multi_select`,
`zone_select`, `tree_placement`, `matrix_2x2`, `sort_to_bin`,
`timeline_placement`, `sequence_order`, `assemble_pieces`, `balance_scale`,
`pairwise_duel`, `spider_compare`, `venn_overlap`, `anchor_adjust`,
`mode_radial_gauge`, `context_readout`, `mcq_context`). Repeats across domains
(e.g. `assemble_pieces` for TBCAF stacks, NPC templates, and monitoring
stacks) are intentional — the same math shape recurs across unrelated
domains, which is exactly the point of pattern-matching against precedent
instead of re-deriving the bucket every time.

## How to use this when pushing a real decision

1. Find the closest precedent above by domain + decision shape.
2. Confirm the shape still matches with `card-type-gate`'s discriminants
   (interval vs. point, fixed-total-split vs. independent, exactly-two vs.
   many) — precedent narrows the search, it doesn't skip verification.
3. Run `card_type_selector.py` to get the bucket/answers the backend
   requires, then push with `decision_hud__decision_push`.
4. If the live decision doesn't actually match its closest precedent's
   discriminants, trust the gate's fresh verdict over this doc — this is a
   pattern-matching aid, not an override authority.
