# Pre-Push Ritual: Countering Satisficing on card_type Choice

## Problem this targets
`card-type-gate` makes classification *auditable* (did the verdict come from
the discriminant engine, not vibes) but does nothing about *when the agent
stops looking*. An agent mid-task tends to phrase the question one way, run
the gate once, get a `resolved` (or an easy `ambiguous`→pick-the-familiar-one)
verdict, and push — never asking whether framing the same underlying decision
differently would have surfaced a richer or rarer-but-more-correct card. This
is anchoring/availability bias, not a taxonomy gap: `question-framing-guide.md`
already shows each card_type implies a specific phrasing, which means most
decisions *can* legitimately be phrased toward more than one shape, and the
first phrasing that comes to mind is rarely a deliberate choice among them.

The gate can't fix this because by the time the gate runs, the question is
already fixed. The fix has to sit in the agent's own head, before it writes
the question down, or right after the first verdict comes back.

## The ritual (run silently, ~30–90 seconds of reasoning, before `decision_push`)

1. **Name the raw decision in one sentence, not yet as a question.** ("We need
   to know if service ownership should default to platform or infra.") If this
   sentence has no real choice in it, stop — this belongs in `context_readout`
   or doesn't need a card at all (`card-type-gate`'s `none_of_these` bypass).

2. **Draft two competing question phrasings of the same decision**, not two
   different decisions. Use `question-framing-guide.md`'s table as the prompt:
   pick the first phrasing that comes to mind, then deliberately try a second
   phrasing that leans on a *different* row of the table (e.g. reframe a
   "pick one" as a "split across" or a "rank" as a "place on a timeline").
   A third is worth trying only if the first two land on the same bucket —
   two is the default budget, not a ceremony.

3. **Run the bucket classification (step 1 of `card-type-gate`) on both
   phrasings separately.** If they land in the same bucket, that's real
   convergent evidence — proceed with confidence, this step is *done*, don't
   manufacture a third framing to force disagreement. If they land in
   different buckets, that's the signal worth pausing on: one framing is
   probably distorting the question to fit a shape the agent already likes.

4. **Ask the anchoring check explicitly:** "Am I about to pick this card_type
   because it's the best fit for the decision, or because it's the first
   phrasing that passed the gate?" If the honest answer is "first one that
   passed," go back to step 2 — you skipped it.

5. **Glance at the rarity/underused list before finalizing**, not to chase
   novelty but to catch a common failure mode: defaulting to `mcq_context`,
   `multi_select`, or `zone_select` out of habit when the decision actually
   has real structure (a split, a mapping, a tradeoff). Recovering the
   `card-type-gate` verdict's own rejected `hits` (on an `ambiguous` result)
   or re-skimming `card-misuse-catalog.md` for the phrasing you almost wrote
   is enough — this is a sanity check, not a quota to fill from rare types.

6. **Run `card_type_selector.py` for real** on the phrasing you settled on.
   Trust `resolved`/`no_match` as-is. On `ambiguous`, use
   `variety-mechanics-tie-breaking.md`'s tiebreaks or the plain-MCQ fallback —
   never manually override a genuine `no_match` to force a shaped card.

7. **Self-check against forced variety before pushing:** if the only reason
   you're leaning toward the rarer/richer card_type is that it *feels* more
   interesting or you haven't used it recently, that's the same anchoring bug
   in the opposite direction — reject it. The gate's verdict on the *best*
   phrasing wins, not the prettiest shape. Variety is a side effect of
   phrasing the question honestly, never a goal pursued at the expense of fit.

8. **Push, and note which of the two phrasings you used** (one line in
   `card_payload` or the push's rationale) so a later audit can see step 2
   actually happened, not just the final `card_type`.

## Scope discipline (don't let this become bureaucratic overhead)
- Skip straight to step 6 for genuinely trivial/obvious decisions — a plain
  yes/no, a single free-text ask, anything that's clearly `mcq_context` or
  `none_of_these` on first read. The ritual exists for decisions with real
  ambiguous shape, not every card pushed all day.
- Steps 2–4 are the only mandatory net-new work over just running the gate
  once; they're a mental exercise (draft two phrasings, compare buckets), not
  two live tool calls unless the buckets actually disagree.
- If step 3 converges on the first try, stop there — convergence *is* the
  evidence of correctness, more framings after that is exactly the kind of
  box-checking this ritual is trying to avoid on the other side.

## Relationship to existing docs
This ritual sits *before* `card-type-gate` (step 6) and *before*
`question-framing-guide.md`'s checklist (used inside step 2 as the framing
prompt). It adds nothing to the discriminant engine itself — no new
card_types, no engine changes. It is purely a habit for the calling agent:
explore framing before locking the question, and interrogate the motive
behind the final pick in both directions (too lazy *and* too eager for
novelty).
