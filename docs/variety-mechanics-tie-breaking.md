# Variety mechanics for card_type tie-breaking

Scope: applies **only** inside `_card_type_verdict()` / `_verify_card_type()`
(`backend-plugin/db.py`) at the moment `status == "ambiguous"` — i.e. `len(hits) > 1`
in the gate (line ~726). Never touches `resolved` (single match, len(hits)==1) or
`no_match`/`incomplete`. Fit is decided entirely by the deterministic discriminant
rules before any of this runs; these mechanics only choose *among genuine ties*,
and only after the caller (agent) has already tried narrowing answers and a real
tie remains.

Today ambiguous hard-fails (`raise ValueError(... narrow the answers ...)`),
which is correct and should stay the default. These mechanics are for the
*optional* second attempt: when the agent legitimately cannot narrow further
(the question really is equally wire_match-shaped and sort_to_bin-shaped),
give it a principled, variety-aware pick instead of always reaching for
whichever card type it used last time.

## 1. Rarity-weighted random pick (loot-table style)
**Where:** inside `_card_type_verdict`, only in the `len(hits) > 1` branch, as an
optional `tiebreak=True` argument. Never changes `hits` computation itself.

Classify all 23 `card_type`s into tiers by real-world applicability breadth
(e.g. common: `multi_select`, `zone_select`, `mcq_context`; uncommon: `balance_scale`,
`sequence_order`, `matrix_2x2`; rare: `venn_overlap`, `spider_compare`,
`tree_placement`, `mode_radial_gauge`). When `hits` contains a mix of tiers,
weight the random pick *inversely* to commonness (rare tiers get higher weight)
so the tie resolves toward the less-habitual-but-still-valid option more often
than 50/50, without ever picking a card not in `hits`. Pure `random.choices(hits, weights=...)`
— stdlib, no new dependency.

## 2. Usage-frequency pity timer
**Where:** same branch, as a second optional tiebreak strategy, reading real
usage counts instead of a static tier table.

Query `decisions` table (already exists — `resolved_choice`/`card_type` columns)
for a rolling window's per-card_type push counts. When two-plus card_types are
tied in `hits`, prefer whichever has the lowest count in that window ("hasn't
been drawn in a while gets pulled to the front of the queue"). This is a plain
`SELECT card_type, COUNT(*) ... GROUP BY card_type` (one line of SQL), no new
storage. Only ever chooses among `hits` — a card_type absent from `hits` cannot
win no matter how starved it is. This directly counters the complaint ("agent
gravitates to a handful of familiar types") because the count is measured, not
guessed by the agent's memory of what it likes.

## 3. Deck-without-replacement per session
**Where:** caller side (the agent loop / MCP tool wrapper around `decision_push`),
NOT inside the gate itself — the gate stays pure/stateless. Applied only when
the gate already returned `ambiguous` with 2+ `hits` for *this* push.

Keep a small in-session set of card_types already used this conversation/board.
When breaking a tie, prefer a `hits` member not yet drawn this session (like a
deck-building "no repeat until reshuffle"); if all tied candidates were already
used, fall back to mechanic #1 or #2. This is a `set()` the caller already has
easy access to (session state) — no schema change, no new table.

## 4. Explicit tie surfaced to the user via existing MCQ fallback
**Where:** caller side, before invoking any auto-tiebreak — this is the safety
valve, always available.

When `ambiguous` fires and the tied `hits` are genuinely close (e.g. differ only
in a cosmetic dimension the user might care about — drag-based sort_to_bin vs.
matrix_2x2), skip auto-tiebreak entirely and push the plain MCQ fallback
(`card_type=None`) listing the tied options as `choices`, letting the human
pick. This is the skill's existing "always keep plain MCQ as fallback" rule —
reused, not new mechanic. Use when #1-#3 would be guessing on the user's
behalf about something they'd likely have an opinion on.

## Non-negotiable boundary (repeated for emphasis)
All four mechanics read from `hits` (the gate's already-computed tie list) and
never add to it, remove from it, or run when `len(hits) == 1`. A `resolved`
verdict is returned as-is, always. Variety is a selection rule over genuine
ties, never a reason to relax the discriminant rules or force-fit an
out-of-`hits` card_type for novelty.
