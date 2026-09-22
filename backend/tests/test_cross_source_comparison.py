"""Focused tests for the Wave 1d cross-source comparison read model.

Uses a fake repository (no Postgres) — `normalize_snapshot` and the derived
metric functions are pure; `CrossSourceComparison.rows()` only needs
`query_by_producer` on its collaborator, matched here with a stub instead
of a live PostgresMetricsRepository.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from agent_telemetry.dashboard.comparison import (
    KANBAN_PATH,
    ComparisonRow,
    CrossSourceComparison,
    avoidance_rate,
    latency_delta,
    net_token_savings,
    normalize_snapshot,
    quality_retention,
)
from agent_telemetry.domain.contracts import MetricSnapshot


def _kanban_snapshot(*, agent_id="alice", input_tokens=1000, output_tokens=200) -> MetricSnapshot:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return MetricSnapshot.from_dict({
        "schema_version": "telemetry.v1", "event_id": str(uuid4()), "producer": "kanban-sync",
        "producer_instance_id": "sync_kanban_telemetry", "occurred_at": now, "received_at": now,
        "agent_id": agent_id, "run_id": str(uuid4()), "task_id": str(uuid4()), "task_type": "kanban-rollup",
        "scope": "project:x", "provenance": "kanban-sync", "idempotency_key": str(uuid4()),
        "source": "checkpoint", "authoritative": True, "completeness": "partial", "captured_at": now,
        "values": {
            "input_tokens": {"raw_value": input_tokens, "value_type": "number", "unit": "count", "category": "model_cost_latency"},
            "output_tokens": {"raw_value": output_tokens, "value_type": "number", "unit": "count", "category": "model_cost_latency"},
        },
        "quality_flags": [],
    })


def _sidecar_snapshot(*, operation="op-a", execution_path="sidecar_active", input_tokens=100,
                       output_tokens=20, latency_ms=250.0) -> MetricSnapshot:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return MetricSnapshot.from_dict({
        "schema_version": "telemetry.v1", "event_id": str(uuid4()), "producer": "sidecars",
        "producer_instance_id": "sidecar_suite.telemetry_sink", "occurred_at": now, "received_at": now,
        "agent_id": operation, "run_id": str(uuid4()), "task_id": str(uuid4()), "task_type": "sidecar-operation",
        "scope": "sidecars", "provenance": f"sidecar:{execution_path}", "idempotency_key": str(uuid4()),
        "source": "checkpoint", "authoritative": True, "completeness": "complete", "captured_at": now,
        "values": {
            "measurement": {
                "raw_value": {"input_tokens": input_tokens, "output_tokens": output_tokens, "latency_ms": latency_ms},
                "value_type": "object", "unit": "mixed", "category": "sidecar_operation_quality",
            },
        },
        "quality_flags": [],
    })


def test_normalize_snapshot_maps_kanban_and_sidecar_rows_distinctly():
    kanban_row = normalize_snapshot(_kanban_snapshot())
    sidecar_row = normalize_snapshot(_sidecar_snapshot())

    assert kanban_row.producer == "kanban-sync"
    assert kanban_row.path == KANBAN_PATH
    assert kanban_row.input_tokens == 1000
    assert kanban_row.quality_score is None  # never fabricated

    assert sidecar_row.producer == "sidecars"
    assert sidecar_row.path == "sidecar_active"
    assert sidecar_row.input_tokens == 100
    assert sidecar_row.latency_ms == 250.0
    assert sidecar_row.quality_score is None  # shadow-mode runs don't always score


def test_missing_quality_score_is_none_not_zero():
    row = normalize_snapshot(_sidecar_snapshot())
    assert row.quality_score is None


class _FakeRepository:
    def __init__(self, by_producer: dict[str, list[MetricSnapshot]]) -> None:
        self._by_producer = by_producer

    async def query_by_producer(self, *, producer: str, limit: int = 500):
        return self._by_producer.get(producer, [])[:limit]


def test_cross_source_comparison_joins_both_producers_without_blending():
    repository = _FakeRepository({
        "kanban-sync": [_kanban_snapshot(agent_id="alice")],
        "sidecars": [_sidecar_snapshot(operation="op-a")],
    })
    comparison = CrossSourceComparison(repository)
    rows = asyncio.run(comparison.rows())

    assert len(rows) == 2
    producers = {r.producer for r in rows}
    assert producers == {"kanban-sync", "sidecars"}


def test_net_token_savings_and_avoidance_rate():
    rows = [
        ComparisonRow("kanban-sync", "baseline", "agent-a", 1000, 200, None, None),
        ComparisonRow("sidecars", "sidecar_active", "op-a", 100, 20, None, None),
        ComparisonRow("sidecars", "sidecar_active", "op-b", 0, 0, None, None),  # fully avoided main-model call
    ]
    savings = net_token_savings(rows, baseline_path="baseline", active_path="sidecar_active")
    assert savings == {"input": 900, "output": 180}
    assert avoidance_rate(rows, active_path="sidecar_active") == 0.5


def test_latency_delta_and_quality_retention():
    rows = [
        ComparisonRow("kanban-sync", "baseline", "a", None, None, 1000.0, 0.9),
        ComparisonRow("kanban-sync", "baseline", "a", None, None, 900.0, 0.8),
        ComparisonRow("sidecars", "sidecar_active", "op", None, None, 300.0, 0.7),
        ComparisonRow("sidecars", "sidecar_active", "op", None, None, 500.0, 0.6),
    ]
    assert latency_delta(rows, baseline_path="baseline", active_path="sidecar_active") == 400.0 - 950.0
    retention = quality_retention(rows, baseline_path="baseline", active_path="sidecar_active")
    assert retention == pytest.approx(0.6 / 0.85)


def test_missing_path_yields_none_derived_metrics_not_fabricated_zero():
    rows = [ComparisonRow("kanban-sync", "baseline", "a", 100, 10, None, None)]
    assert avoidance_rate(rows, active_path="sidecar_active") is None
    assert latency_delta(rows, baseline_path="baseline", active_path="sidecar_active") is None
    assert quality_retention(rows, baseline_path="baseline", active_path="sidecar_active") is None
