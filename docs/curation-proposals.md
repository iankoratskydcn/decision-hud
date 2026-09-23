# Decision HUD as a Deck, Not a Menu

The gate (`card_type_selector.py`) is deterministic on purpose: for a question with
one real mathematical shape, there is exactly one right card, and it should never
be picked for variety's sake. The "rarely see the full deck" complaint isn't a gate
problem — it's a *legibility and feedback* problem. These proposals add curation
without ever overriding the gate's verdict.

## 1. Surface the gate's rationale as a caption, not just a badge
Every gate match already returns a one-line rationale (`[[card_type, rationale], ...]`).
Render it as a small caption under the card's tag in `plugin.js`, the way a tasting
menu prints "seared, not braised — the dish's own logic" under a course name.
*Rationale: turns "why did I get steppers for this" into visible proof of fit,
directly countering the force-fit complaint — the reasoning is on the card, not hidden in the push.*

## 2. A visible "family" tag per card (gallery wing signage)
Group the 23 renderers into the buckets the gate already uses (mapping, scalar,
discrete_choice, categorize, rank_sequence, compose, compare_tradeoff, membership,
recommend_override, reactive_config, info_only) and show a small colored tag/icon
per family in the card header. *Rationale: a museum visitor feels variety by seeing
they've moved between wings, not by every piece being unique — this makes the
deck's actual breadth visible over a session even when today's card is a repeat.*

## 3. Recency-aware tiebreak, but only on genuine `ambiguous` verdicts
When the gate returns `status: "ambiguous"` between two competing card_types (its
documented, valid outcome — never on `"resolved"`), break the tie toward whichever
of the two was used less recently, via a `decision_list` lookback. *Rationale: this
is a sommelier not pouring the same wine twice when either pairing genuinely works —
it adds variety only in the exact place the gate already admits freedom exists,
so it can't cause a force-fit.*

## 4. A recurring "what's been served" context_readout
Periodically (e.g. every N decisions or weekly), push a `context_readout`
(`variant: "compare_bars"`) showing the recent card_type usage distribution —
using an existing card type, not a new one. *Rationale: this is the tasting-menu
chef's own retro, done in front of the diner: makes the agent's card habits
visible to the user and to itself, so "keeps defaulting to the same 4 shapes"
becomes an observable, fixable pattern instead of an anecdote.*

## 5. Log the classification bucket next to every push (audit trail as curation memory)
Per the gate's own verification step, note which bucket/verdict produced each
`card_type` (in `card_payload` or an adjacent log line). Feed that log into
proposals 3 and 4. *Rationale: a curator's variety comes from remembering what
was already shown, not from improvising in the moment — this is the minimal
memory that makes recency-awareness and the usage retro possible at all,
with no new storage beyond what's already logged.*

## Explicitly not proposed
No new card types, no randomized/forced rotation across `resolved` verdicts, and
no UI mechanism that could make a wrong-shape card "feel" more right — variety here
is *visibility and tiebreak-only*, never a reason to override the discriminant engine.
