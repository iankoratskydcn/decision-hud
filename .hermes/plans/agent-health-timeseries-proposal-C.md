# Agent Health metric history store — proposal (design C)

## 0. Does this need to exist?

Yes, per brief — `query_recent_metrics` only returns latest-per-agent, so
`agentHealthBarPct`'s percentile/z-score modes currently normalize against
whatever agents happen to be on screen *right now*, not a real distribution
over time. There is no existing table this reuses for free (checked
`telemetry_snapshots` — one full JSONB envelope per checkpoint, no
history query; `task_runs` — live-aggregated, not a stored series; neither
gives cheap "value of metric X for agent Y at time T" access without a scan).

## 1. Reject the naive design first

Naive: `metric_points(agent_id text, metric_key text, ts timestamptz,
value double precision)`, one row per (agent, metric, sample). At ~5 metrics
× N agents × 1 write/poll-tick (4s client poll → say downsampled to 60s
store-side) that's already a Postgres row with:
- tuple header ~23 bytes
- 3 text/timestamptz/float8 columns, each with alignment padding
- a btree index entry per row for any usable read pattern (agent_id, ts)

Realistic Postgres per-row cost including index: **60-100 bytes/datapoint**,
before autovacuum bloat from constant small-row churn, before WAL amplification
from one-row-per-INSERT traffic. For 10 agents × 5 metrics × 1440
samples/day that's 72,000 rows/day ≈ 5-7 MB/day, purely from row/index
overhead on ~8 bytes of actual payload (an int and a timestamp). This is
the exact "generic wide event log" mistake the existing `telemetry_snapshots`
table already makes, just at a different grain — more rows, not less
overhead.

## 2. What the data actually looks like (why it compresses so well)

- Values are small integers (task counts, 0-50ish) or USD costs (2 decimal
  places, small magnitude).
- Samples are taken at a *store-decided* cadence, not tied to the 4s client
  poll — the store gets to choose.
- Most metrics **don't change between samples** most of the time (a `done`
  counter that ticks up a few times an hour, sampled every 60s, is flat
  >95% of the time).
- Consumers only need aggregate stats (max, mean, stdev, sorted list for
  percentile) over a rolling window (e.g. "last N days") per (agent, metric)
  — not point-in-time lookup of one exact timestamp.

That last property is the one the naive design and both existing tables
miss: nobody needs row-level random access to "value at 14:32:07 exactly."
They need **a compact ordered array of samples per (agent, metric) they can
scan in one shot**. That reframes the problem from "OLTP row store" to
"one blob per series."

## 3. Chosen design: one JSON/array blob per (agent, metric) series, delta+RLE encoded, in Postgres

### Schema

```sql
CREATE TABLE agent_metric_series (
    scope       text NOT NULL,
    agent_id    text NOT NULL,
    metric_key  text NOT NULL,
    day         date NOT NULL,          -- one row per series per UTC day
    base_ts     timestamptz NOT NULL,   -- ts of first sample that day
    -- packed samples for that agent/metric/day, see encoding below
    samples     bytea NOT NULL,
    sample_count integer NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, agent_id, metric_key, day)
);
```

One row per **(agent, metric, day)**, not per sample. A day's worth of
samples for one series lives in a single `bytea` column, appended to
in-place as new samples land. This turns "N rows/day" into "≤ (agents ×
metrics) rows/day" — for 10 agents × 5 metrics that's 50 rows/day total,
regardless of sampling cadence, vs. 72,000 in the naive design.

### Encoding inside `samples` (fixed-width binary + delta + RLE)

Each sample conceptually is `(seconds_since_base_ts: uint32, value)`.
Two encodings, chosen per-write by whichever is smaller — this is the
"consider approaches the obvious design might miss" part:

1. **Fixed-width delta-of-value record** (default, for counts):
   `struct.pack('<Hh', dt_seconds_from_prev, delta_value)` — 4 bytes/sample:
   a `uint16` seconds-since-previous-sample (fits any cadence up to ~18h
   gaps; store a sentinel + full record on overflow) and an `int16` delta
   from the previous value (task counts and cost deltas fit easily in
   ±32767). First sample in the day is a full record (8 bytes: `<Id` ts+value)
   to anchor the series; every subsequent sample is the 4-byte delta record.

2. **Run-length collapse before encoding**: because most metrics are flat
   between samples (see §2), the *write path never appends a delta record
   at all when delta==0 and the previous record already represents ≥2
   ticks* — instead it bumps a `repeat count` byte on the last record
   (a run-length byte capped at 255, i.e. up to 255× the write cadence of
   flat-line coverage per byte). So a metric that sits at `done=7` for two
   hours at a 60s write cadence costs **1 byte total**, not 120 × 4 bytes.

This is exactly delta encoding + RLE stacked, which is standard in
production time-series engines (Gorilla/Facebook's TSDB encoding, InfluxDB's
column encodings) — reused here as a hand-rolled ~30-line encode/decode
pair rather than pulling in a dependency, because the value domain (small
ints/small floats, bounded cardinality of change) is exactly the case those
algorithms are built for, and the encode/decode logic is small enough that
writing it beats vendoring and learning a new library's on-disk format for
one call site.

### Why not columnar (Parquet-in-a-column) or an external TSDB dependency?

- **Parquet/columnar file per day**: real columnar formats (row groups,
  min/max stats, dictionary encoding) pay for themselves at MB-GB scale;
  at this data volume (a few hundred bytes/series/day) the format's own
  footer/metadata overhead (typically KBs) would dwarf the payload. Rejected
  — solving a scale problem that doesn't exist here.
- **External TSDB (Prometheus/InfluxDB/TimescaleDB extension)**: adds an
  operational dependency (a whole new service or a Postgres extension to
  install/manage) for a metric volume this codebase's own numbers show is
  tiny (a few thousand datapoints/day across all agents). Also the project
  already runs Postgres for `telemetry_snapshots` — a second store for a
  strict subset of the same conceptual data is more moving parts, not less.
  Rejected on the ladder's rung 2 ("reuse what's already in this codebase")
  vs. rung 5 (new dependency).
- **Piggyback on `telemetry_snapshots` via a cheap trick** (e.g. add a
  generated column or a partial index on `payload->'values'->key->>'raw_value'`
  to make history queryable in place): considered seriously — it reuses the
  existing table and write path (`write_checkpoint` already fires on every
  checkpoint). Rejected because that table is *append-only per full envelope
  event* (duplicates producer/scope/quality_flags/etc. every checkpoint) —
  querying history off it means scanning full JSONB rows to pull one int out
  of a nested key, with no compaction path; it inherits all the "wide event
  log, not metric-optimized" cost the brief explicitly flags. It remains the
  right store for *why* something happened (audit/debug); this new table is
  for *what the numbers were over time* — different access pattern,
  deliberately separate and much smaller.
- **SQLite side-file instead of Postgres**: genuinely simpler operationally
  (no migration, no connection pool) but the project already has an open,
  migrated Postgres connection and `write_checkpoint`'s per-event call site
  is exactly where a second cheap write would go; adding a second DB file
  to open/lock only pays off if Postgres weren't already there. Noted as
  the fallback if this ever needs to run somewhere without Postgres access,
  but not chosen given the existing stack.

### Write path

Hook into the same place `sync_kanban_telemetry.py` / the poll cycle
already produces a fresh scalar reading (or, cheaper: hook `write_checkpoint`
itself, since every checkpoint already carries the `values` dict this needs —
no new producer, just an additional cheap append alongside the existing
`INSERT INTO telemetry_snapshots`):

1. For each `(agent_id, metric_key, value)` in the incoming checkpoint's
   `values` dict, `UPSERT` into `agent_metric_series` keyed on
   `(scope, agent_id, metric_key, today)`:
   - If no row for today: insert with `samples` = 8-byte anchor record.
   - If row exists: read `samples`, decode last record, compare to new
     value — if equal, bump its RLE repeat byte (in-place `bytea` splice,
     no full rewrite needed since it's the last 1 byte); if different,
     append a 4-byte delta record.
2. This is a single small UPDATE per changed metric, at most once per
   *store-chosen* cadence (e.g. reject/no-op writes closer together than
   60s — cheapest possible throttle: compare `updated_at`), decoupled from
   the 4s client poll entirely.

### Read path

`SELECT samples, sample_count, base_ts FROM agent_metric_series WHERE
scope=$1 AND agent_id = ANY($2) AND metric_key=$3 AND day >= $4 ORDER BY day`
— one row scan per agent per requested day range, decode the small `bytea`
blob into a flat list of `(ts, value)` in application code (the ~30-line
decoder, inverse of the encoder above), concatenate across days, and feed
straight into the same `values`/`n`/`max`/`mean`/`stdev` shape
`agentHealthMetricStats` already computes client-side — except now
computed server-side (or still client-side, same shape) over real history
instead of the current on-screen snapshot. A new read-model method
(`query_metric_history(scope, agent_ids, metric_key, since)`) mirrors
`query_recent_metrics`'s existing shape and bounds.

### Retention

- Grain is per-day, so retention is a trivial `DELETE FROM
  agent_metric_series WHERE day < now() - interval 'N days'` — no
  per-row TTL bookkeeping, no need to touch `telemetry_snapshots`' retention
  policy at all (kept separate on purpose).
- Recommend 90 days by default (covers any reasonable "historical
  distribution" window for percentile/z-score without unbounded growth);
  trivially configurable since it's one predicate on one indexed column
  (`day`, already the tail of the primary key so this is an index range
  scan, not a full-table delete).
- Optional: monthly rollup (min/max/mean/count) for anything older than
  retention if a "the shape over quarters" view is ever wanted — out of
  scope until asked for (YAGNI), noted only because the schema doesn't
  block it (a `agent_metric_daily_rollup` table would be a natural sibling,
  not a rework).

## 4. Bytes-per-datapoint estimate

Assume 10 agents × 5 metrics, 60s write cadence, typical case ~80% of
samples are unchanged from the previous (collapse into RLE bump) and ~20%
carry a real delta:

- Unchanged sample: **amortizes to ~0 bytes** (folds into existing repeat
  byte, no growth in `samples` until the byte would overflow at 255 repeats
  ≈ 4.25h, at which point one more byte starts a new run — worst case still
  ~1 byte per 255 flat samples).
- Changed sample: **4 bytes** (delta record).
- Per series per day: 1 anchor record (8 bytes) + ~(1440 samples × 20%
  change rate ÷ avg run length, roughly) a few hundred delta records +
  occasional RLE-continuation bytes ≈ **roughly 300-600 bytes/series/day**
  in the realistic case, vs. naive design's 1440 samples × ~70 bytes/row
  (row+index overhead) = **~100,000 bytes/series/day**.
- Per-row Postgres overhead (tuple header, PK, UPSERT churn) is paid
  **once per series per day** (50 rows/day total across 10 agents × 5
  metrics), not once per sample — so it amortizes to a few bytes/datapoint
  instead of being the dominant cost.
- **Net: ~0.3-0.5 bytes/datapoint at realistic change rates, vs. ~70-100
  bytes/datapoint for the naive one-row-per-sample table** — roughly a
  150-300x reduction, dominated by (a) killing per-sample row/index
  overhead via day-grain batching and (b) RLE eating the (very common)
  unchanged-value case for free.

## Summary — biggest storage-saving idea

Stop storing one database row per sample. Batch a whole day's samples for
one (agent, metric) into a single small `bytea` blob (one row per series
per day, not per sample), and encode that blob as delta-from-previous-value
plus run-length-collapse of unchanged runs. Because these metrics are small
integers that rarely change between polls, RLE alone eliminates the vast
majority of the data, and delta encoding shrinks what's left to a few bytes
each — turning per-sample row/index overhead (the real cost in any naive
schema) into a fixed, tiny, once-per-series-per-day cost instead of a
per-sample one.
