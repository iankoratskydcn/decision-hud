"""Cross-source cost/quality/speed comparison (Wave 1d).

Normalizes `producer="kanban-sync"` and `producer="sidecars"` telemetry.v1
snapshots (see Wave 0a/0b) onto one comparable row shape and derives the
metric vocabulary already defined in `~/GitHub/sidecars/
SIDECAR_RANKING_AND_EVALUATION_PLAN.md`'s "Derived metrics" section (net
token savings, avoidance rate, latency delta, quality retention) — no new
vocabulary invented here.

Sources are joined by `producer`, never blended into one row: a Kanban
agent run and a sidecar operation are always distinguishable via
`ComparisonRow.producer`/`.path`.
"""
from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any, Iterable

# Kanban-sync rows carry no explicit `path`; they are plain agent runs, not
# part of the sidecar baseline/shadow/active spectrum.
KANBAN_PATH = "kanban_agent"


@dataclass(frozen=True)
class ComparisonRow:
    producer: str
    path: str
    agent_id: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: float | None
    quality_score: float | None


def normalize_snapshot(snapshot: Any) -> ComparisonRow:
    """Map one telemetry.v1 `MetricSnapshot` onto a `ComparisonRow`.

    Missing fields (e.g. sidecar `quality_score`, which shadow-mode runs
    don't always populate) become `None`, never a fabricated 0 — "not yet
    judged" and "zero" are different facts.
    """
    values = snapshot.payload["values"]
    producer = snapshot.producer

    def _raw(key: str) -> Any:
        entry = values.get(key)
        return entry["raw_value"] if entry is not None else None

    if producer == "sidecars":
        measurement = _raw("measurement") or {}
        provenance_str = snapshot.payload.get("provenance", "")
        path = provenance_str.split(":", 1)[1] if ":" in provenance_str else provenance_str
        return ComparisonRow(
            producer=producer,
            path=path or "unknown",
            agent_id=snapshot.agent_id,
            input_tokens=measurement.get("input_tokens"),
            output_tokens=measurement.get("output_tokens"),
            latency_ms=measurement.get("latency_ms"),
            quality_score=_raw("quality_score"),
        )

    # kanban-sync (or any other future non-sidecar producer): flat values dict.
    return ComparisonRow(
        producer=producer,
        path=KANBAN_PATH,
        agent_id=snapshot.agent_id,
        input_tokens=_raw("input_tokens"),
        output_tokens=_raw("output_tokens"),
        latency_ms=_raw("latency_ms"),
        quality_score=_raw("quality_score"),
    )


class CrossSourceComparison:
    """Read-model surfacing joined, producer-tagged comparison rows."""

    def __init__(self, repository: Any) -> None:
        self.repository = repository

    async def rows(self, *, limit: int = 500) -> list[ComparisonRow]:
        kanban_snapshots = await self.repository.query_by_producer(producer="kanban-sync", limit=limit)
        sidecar_snapshots = await self.repository.query_by_producer(producer="sidecars", limit=limit)
        return [normalize_snapshot(s) for s in (*kanban_snapshots, *sidecar_snapshots)]

    async def status(self, *, limit: int = 500, baseline_path: str = "baseline") -> dict[str, Any]:
        """Wave 2d panel payload: raw rows plus, for every non-baseline
        `path` present in those rows, the derived comparator vocabulary
        from `SIDECAR_RANKING_AND_EVALUATION_PLAN.md` against
        `baseline_path`. Filtering to one path (`sidecar_active` vs
        `baseline` vs `kanban_agent`) is a client-side concern — this
        returns every path's numbers so the UI panel can filter without a
        round trip.
        """
        rows = await self.rows(limit=limit)
        active_paths = sorted({r.path for r in rows if r.path != baseline_path})
        comparisons = {
            path: {
                "net_token_savings": net_token_savings(rows, baseline_path=baseline_path, active_path=path),
                "avoidance_rate": avoidance_rate(rows, active_path=path),
                "latency_delta_ms": latency_delta(rows, baseline_path=baseline_path, active_path=path),
                "quality_retention": quality_retention(rows, baseline_path=baseline_path, active_path=path),
            }
            for path in active_paths
        }
        return {
            "schema_version": "agent-dashboard-comparison.v1",
            "baseline_path": baseline_path,
            "rows": [
                {
                    "producer": r.producer,
                    "path": r.path,
                    "agent_id": r.agent_id,
                    "input_tokens": r.input_tokens,
                    "output_tokens": r.output_tokens,
                    "latency_ms": r.latency_ms,
                    "quality_score": r.quality_score,
                }
                for r in rows
            ],
            "comparisons": comparisons,
        }


def _tokens(rows: Iterable[ComparisonRow], path: str) -> tuple[int, int]:
    matched = [r for r in rows if r.path == path]
    return (
        sum(r.input_tokens or 0 for r in matched),
        sum(r.output_tokens or 0 for r in matched),
    )


def net_token_savings(rows: Iterable[ComparisonRow], *, baseline_path: str, active_path: str) -> dict[str, int]:
    """baseline main-model tokens − active-path tokens (main-model + any sidecar calls), input/output separate.

    `active_path` rows already carry every token spent to complete the task
    on that path — main-model and sidecar alike (the contract's `measurement`
    doesn't split them further) — so this is a single subtraction, not an
    additional sidecar-token term that would double count the same rows.
    """
    rows = list(rows)
    baseline_in, baseline_out = _tokens(rows, baseline_path)
    active_in, active_out = _tokens(rows, active_path)
    return {"input": baseline_in - active_in, "output": baseline_out - active_out}


def avoidance_rate(rows: Iterable[ComparisonRow], *, active_path: str) -> float | None:
    """completed tasks with no main-model call ÷ eligible tasks, for one active path."""
    eligible = [r for r in rows if r.path == active_path]
    if not eligible:
        return None
    avoided = sum(1 for r in eligible if not r.input_tokens and not r.output_tokens)
    return avoided / len(eligible)


def latency_delta(rows: Iterable[ComparisonRow], *, baseline_path: str, active_path: str) -> float | None:
    """p50 active minus p50 baseline latency_ms (simple median; no percentile lib needed at this scale)."""
    baseline = sorted(r.latency_ms for r in rows if r.path == baseline_path and r.latency_ms is not None)
    active = sorted(r.latency_ms for r in rows if r.path == active_path and r.latency_ms is not None)
    if not baseline or not active:
        return None
    return _median(active) - _median(baseline)


def quality_retention(rows: Iterable[ComparisonRow], *, baseline_path: str, active_path: str) -> float | None:
    """active quality ÷ baseline quality; never average away catastrophic failures (min, not mean, for active)."""
    baseline = [r.quality_score for r in rows if r.path == baseline_path and r.quality_score is not None]
    active = [r.quality_score for r in rows if r.path == active_path and r.quality_score is not None]
    if not baseline or not active:
        return None
    baseline_avg = mean(baseline)
    if baseline_avg == 0:
        return None
    return min(active) / baseline_avg


def _median(values: list[float]) -> float:
    n = len(values)
    mid = n // 2
    return values[mid] if n % 2 else (values[mid - 1] + values[mid]) / 2
