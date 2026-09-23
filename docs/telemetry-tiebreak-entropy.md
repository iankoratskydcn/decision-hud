# Entropy-informed tie-breaking for card_type variety

Extends `docs/variety-mechanics-tie-breaking.md` mechanic #2 ("usage-frequency
pity timer") with a concrete, implementable stats surface. Same boundary
applies and is restated below because it's the one rule that must never be
violated by anything in this doc.

## Non-negotiable boundary
Telemetry may only choose **among the `hits` list `_card_type_verdict()`
already returned for `status == "ambiguous"`** (`len(hits) > 1`). It is never
consulted, and has no effect, when the gate returns `resolved`
(`len(hits) == 1`) — a correct single match ships as-is, full stop. Fit is
decided entirely by the deterministic discriminant rules in `_CARD_TYPE_RULES`
*before* any telemetry runs. Telemetry cannot add a card_type to `hits`,
remove one, or fire on `no_match`/`incomplete`.

## Rung 1 asked first: does this need a new table?
No. `decisions.card_type` already exists (v2 migration) and is populated on
every successful `push_decision()` call. A histogram is one `GROUP BY` query
against data already being written for other reasons. **No schema change.**
The only genuinely new thing is a read-only aggregation query plus a thin
MCP/CLI wrapper around it — not storage.

(Considered and rejected: a dedicated `card_type_usage` counter table updated
on every push. Rejected because it's a derived value with a trivial
recomputation cost — `decisions` already has an index-friendly `card_type`
column and the table stays small — and a denormalized counter is one more
thing that can drift from the source of truth. Add it later only if `EXPLAIN
QUERY PLAN` on a real large `decisions` table shows the GROUP BY is actually
slow, which it won't be at Decision HUD's scale.)

## The query (db.py, new read-only function)
```python
def card_type_usage_stats(conn: sqlite3.Connection, *, window: int = 200) -> dict:
    """Histogram + entropy + underuse ranking over the most recent `window`
    resolved-gate pushes (card_type IS NOT NULL). Read-only, no side effects,
    safe to call before every ambiguous push.
    """
    rows = conn.execute(
        "SELECT card_type FROM decisions WHERE card_type IS NOT NULL "
        "ORDER BY created_at DESC LIMIT ?", (window,),
    ).fetchall()
    counts = collections.Counter(r["card_type"] for r in rows)
    total = sum(counts.values())
    all_types = {ct for ct, _, _ in _CARD_TYPE_RULES}  # includes never-used (count 0)
    hist = {ct: counts.get(ct, 0) for ct in sorted(all_types)}

    # Shannon entropy of the observed distribution, normalized to [0, 1]
    # against the max possible entropy (uniform over len(all_types)).
    import math
    probs = [c / total for c in hist.values() if c > 0] if total else []
    entropy_bits = -sum(p * math.log2(p) for p in probs)
    max_bits = math.log2(len(all_types))
    normalized_entropy = (entropy_bits / max_bits) if max_bits else 0.0

    return {
        "window": window, "total_pushes": total,
        "histogram": hist,                    # {card_type: count}, all 23 keys present
        "normalized_entropy": round(normalized_entropy, 3),  # 0 = one type only, 1 = perfectly even
        "underused": sorted(all_types, key=lambda ct: hist[ct]),  # rarest-first
    }
```
`window` bounds the query so long-lived boards don't drag in years-old usage
that no longer reflects current question mix; default 200 is a knob, not a
promise — tune once real data exists.

## The MCP tool / CLI surface
```python
@mcp.tool()
def decision_card_type_stats(window: int = 200) -> str:
    """Read-only usage histogram over the last `window` resolved card pushes.
    Informational only — never call this to pick a card_type for a push that
    already resolved to exactly one match; it exists solely to break genuine
    ties (gate status == "ambiguous") toward underused types, and to answer
    "what have I been using" questions.
    """
    conn = db.connect()
    try:
        return json.dumps(db.card_type_usage_stats(conn, window=window))
    finally:
        conn.close()
```
CLI mirror: `hermes decision stats [--window N]` — same pattern as the
existing `decision list`/`decision projects` verbs in `cli.py`, prints the
JSON (or a formatted table) for a human (Ian) checking variety directly,
independent of any agent tie-break logic.

## How an agent should actually use this (the workflow)
1. Run the discriminant answers through `_card_type_verdict()` (or the
   card-type-gate script) as already required.
2. **`status == "resolved"`**: push it. Done. Never call
   `decision_card_type_stats` first, never let it change the outcome — a
   single correct match is not up for a vote.
3. **`status == "ambiguous"`**: *only now* call `decision_card_type_stats()`.
   Restrict its `histogram` to the tied `hits` subset, pick whichever tied
   candidate has the lowest count (equivalently: rerank `hits` by
   `histogram[ct]` ascending). This is the existing mechanic #2, now backed
   by a callable stats endpoint instead of an ad-hoc query the agent would
   otherwise have to write itself each time.
4. **`status == "no_match"`/`"incomplete"`**: unaffected; existing fallback
   rules apply (`card_type=None` plain MCQ, or narrow the answers).

`normalized_entropy` is a diagnostic for Ian ("is the deck actually spread
out"), not an input to step 3's per-push choice — a low global entropy score
does not, by itself, license overriding any single push's resolved result.
It's a health metric to glance at (surfaced well by
`CARD_VARIETY_VISIBILITY_PROPOSAL.md`'s Settings tab idea), not a control
signal that reaches into `_verify_card_type()`.

## Why the boundary holds mechanically, not just by convention
`_verify_card_type()` is the only enforcement point (`push_decision()` calls
it, `decision_push` MCP tool has no way around it). Telemetry lives entirely
outside that function — `card_type_usage_stats()` never calls
`_verify_card_type()` or `_card_type_verdict()`'s `resolved` branch, and
`_verify_card_type()` never calls telemetry. There is no code path by which a
usage count can change what `resolved_card_type = result["matches"][0][0]`
evaluates to. The only place telemetry output touches a push is client-side,
in step 3 above, and only after the gate itself already said "ambiguous".

## What this doc adds over the existing variety-mechanics doc
- A concrete function signature and query (`card_type_usage_stats`), not just
  the mechanic description.
- Entropy as the reported health metric (answers "how skewed is usage,
  quantitatively" for Ian/dashboards), kept strictly separate from the
  per-push tie-break rule (which stays a plain min-count pick — entropy of
  the whole distribution is not itself a per-push decision rule, just the
  number that motivates having one).
- An explicit MCP tool + CLI verb so the agent has one call to make instead
  of hand-rolling a `GROUP BY` each time it hits `ambiguous`.

## Explicitly not built (YAGNI)
- No new table, no counter maintenance, no migration.
- No automatic override of a `resolved` verdict for "the deck is too skewed"
  — always requires human/skill-doc intervention (raise the discriminant
  design, add a card_type, whatever) if global entropy is chronically low;
  that's a design problem, not something a tiebreak can fix.
- No weighting/decay/recency-curve beyond the simple `window` cutoff — add a
  real decay function only if a flat window proves too coarse in practice.
