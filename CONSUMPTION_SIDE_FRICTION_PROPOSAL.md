# Consumption-side friction: why agents dodge rich card_types

The push side is gated deterministically (`card_type_selector.py`) — an agent
can't cherry-pick a plain `mcq_context` for a shape that doesn't fit. But once
a rich card resolves, `decision_check`/`decision_list` hand back
`resolved_payload` shaped per card_type (`{champion_key, bracket_log: [...]}`
for `pairwise_duel`, `{per_axis_winner, tally}` for `spider_compare`,
`{placements: {...}}` for `sort_to_bin`/`tree_placement`, ...). An agent that
wants to *act* on the result — not just print it — has to write bespoke
parsing per card_type it might encounter, 23 times over. That's activation
energy on the read side that never shows up in the push-side gate, and it's a
plausible reason agents lean on `problem_report`/plain MCQ even when the
question's real shape is richer.

One thing already cuts this risk in half: `resolved_choice` (plain string) is
**always** set alongside `resolved_payload`, by design (see `db.py`
docstring: "always kept as a human-readable summary even when
resolved_payload_json is also set"), and every renderer already builds a real
one-liner for it — `PairwiseDuelCard` resolves `"Postgres"` (the champion's
label), `SpiderCompareCard` resolves `"Postgres wins 4 of 5 axes, 1 tie"`, not
just a key. So a consumer that only needs "what was decided" already has a
free, uniform string field and never needs to touch `resolved_payload` at
all. The friction is specifically for a consumer that needs a *fact from
inside* the structure (which axis lost, who the runner-up was, which bin an
item landed in) — that's where 23 bespoke parsers loom.

Ladder check before proposing new code: (1) does this need new code — partly
no, `resolved_choice` already is proposal-1-shaped and just needs to be
documented as the default; (2) reuse what's here — the per-card-type payload
contracts are already written in `decision-hud-cards/SKILL.md`, they just
document how to *build* a payload, not how to *read* one back; (3)
stdlib/(4)/(5) don't apply, this is a documentation + one small normalization
function problem, not a library problem.

## Proposal 1 — Document "read resolved_choice first" as the default pattern (no code)
Add one paragraph to `decision-hud-cards/SKILL.md`'s workflow section, next
to the existing push payload-contract table:

> **Consuming a resolution:** default to `resolved_choice` — every card type,
> including the richest ones, resolves it as a real human-readable summary
> (verify against the "Resolves `{...}`" line for that card_type; the string
> version is built right next to the payload in every renderer). Only reach
> into `resolved_payload` when you need a fact `resolved_choice` doesn't
> carry (e.g. the full bracket path, not just the champion). Most callers
> never need to parse `resolved_payload` at all.

Cost: one paragraph. Payoff: removes the *assumption* that a rich card_type
forces payload-parsing — for the common case (agent just needs to continue
with "what was decided"), it never does. This alone addresses a chunk of the
avoidance, because the actual API is already easier than agents seem to
assume; nobody wrote down that `resolved_choice` is card_type-agnostic and
always sufficient for the summary case.

## Proposal 2 — Per-card_type "how to consume" line next to each "how to push" line
The SKILL.md payload-contracts section already has one line per card_type
documenting the push shape and the `Resolves {...}` shape. Extend each line
with the one Python expression that gets the single most useful fact out,
right where the push contract already lives (so there's one place to look,
not two):

```
- pairwise_duel: ... Resolves {champion_key, bracket_log: [...]}.
  Consume: decision["resolved_payload"]["champion_key"] (the winner's key;
  resolved_choice already has the winner's label if you just need to display it).
- spider_compare: ... Resolves {per_axis_winner: {axis_key: 'a'|'b'|'tie'}, tally}.
  Consume: decision["resolved_payload"]["tally"] for score-based branching
  (tally["a"] > tally["b"]); per_axis_winner only if you need a specific axis.
- sort_to_bin / tree_placement: ... Resolves {placements: {item_key: bin_key}}.
  Consume: decision["resolved_payload"]["placements"].get(item_key) per item,
  or invert once with {v: [k for k,v2 in placements.items() if v2==v] for v in bins}
  if you need "what's in bin X".
```

Cost: ~1 line per card_type (23 lines total), pure documentation, no new
runtime code, no new file. Payoff: an agent facing a rich resolved_payload
for the first time copies a known-correct one-liner instead of improvising
parsing logic from the schema description — this is the same ladder move as
the existing push-side contracts (rung 2: the pattern to extend already
exists, don't invent a new mechanism next to it).

## Proposal 3 — One normalization helper for cross-card_type scripts only
For the one real case documentation can't cover — an agent or dashboard that
needs to summarize *many* decisions across *different* card_types uniformly
(e.g. a digest job, not a single push/resolve round-trip) — add one function
to `db.py` next to `get_decision`:

```python
def resolved_summary(decision: dict) -> str:
    """Uniform one-line summary for any resolved decision, regardless of
    card_type. Always returns resolved_choice — it's already the built
    human-readable string for every renderer — kept as a named entry point
    so cross-card_type callers (digests, dashboards) have one function to
    call instead of re-deciding per script whether to trust resolved_choice
    or hand-parse resolved_payload."""
    return decision.get("resolved_choice") or ""
```

This is deliberately a one-liner, not a 23-branch normalizer — since
`resolved_choice` already *is* the uniform digest (proposal 1's finding),
the only missing piece was a documented, named place to call it from so
digest/dashboard code doesn't reinvent "should I read resolved_choice or
resolved_payload" per script. Skip building the tempting alternative (a
`payload_digest` field computed server-side per card_type with 23 extraction
branches) — it would just be a second, parallel implementation of the string
`PairwiseDuelCard`/`SpiderCompareCard`/etc. already build client-side at
resolve time. Don't maintain two summarizers for the same fact.

## Explicitly not proposed
- No new `resolved_payload` schema version or wrapper field — `resolved_choice`
  already fills the "always-present one-line digest" role; adding a second
  field with the same job is duplication, not friction relief.
- No generic payload-flattening library that tries to guess a common shape
  across all 23 card_types — the shapes are genuinely different (a bracket
  log is not a placements dict); forcing them into one interface would hide
  real structure an agent sometimes needs, and none of these 23 types are
  numerous enough yet to justify an abstraction over "read this dict".
