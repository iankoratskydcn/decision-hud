"""Focused tests for the read-model freshness/staleness/unavailable contract.

Explicit states: `live`->`fresh` in read-model terms (matches existing
per-agent freshness vocabulary), `stale` (backend reachable, no recent
sync), `unavailable` (backend unreachable) - replaces the prior binary
503-or-nothing behavior.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from agent_telemetry.dashboard.read_model import DashboardReadModel, PLUGIN_SCHEMA_VERSION

SCOPE = "project:selected"


def _metric_value(raw_value=12.5):
    return SimpleNamespace(raw_value=raw_value, unit="tokens/min", category="resource")


class _FreshRepository:
    async def query_recent_metrics(self, *, scope, agent_ids, limit):
        now = datetime.now(timezone.utc).isoformat()
        return [SimpleNamespace(agent_id="agent-a", captured_at=now, values={"m": _metric_value()})]


class _StaleRepository:
    async def query_recent_metrics(self, *, scope, agent_ids, limit):
        old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        return [SimpleNamespace(agent_id="agent-a", captured_at=old, values={"m": _metric_value()})]


class _DownRepository:
    async def query_recent_metrics(self, *, scope, agent_ids, limit):
        raise ConnectionError("connection refused")


@pytest.mark.asyncio
async def test_status_is_fresh_when_recent_data_present():
    model = DashboardReadModel(_FreshRepository(), freshness_threshold=timedelta(minutes=5))
    status = await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    payload = status.to_dict()
    assert payload["freshness"]["state"] == "fresh"
    assert payload["agents"]


@pytest.mark.asyncio
async def test_status_is_stale_when_backend_up_but_data_old():
    model = DashboardReadModel(_StaleRepository(), freshness_threshold=timedelta(minutes=5))
    status = await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    payload = status.to_dict()
    assert payload["freshness"]["state"] == "stale"
    # Stale is NOT unavailable: the backend answered, agents/metrics stay real.
    assert payload["agents"]
    assert payload["metrics"]


@pytest.mark.asyncio
async def test_status_is_unavailable_when_backend_unreachable_never_fabricates():
    model = DashboardReadModel(_DownRepository(), freshness_threshold=timedelta(minutes=5))
    status = await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    payload = status.to_dict()
    assert payload["freshness"]["state"] == "unavailable"
    assert payload["agents"] == []
    assert payload["metrics"] == []
    assert payload["schema_version"] == PLUGIN_SCHEMA_VERSION


@pytest.mark.asyncio
async def test_unavailable_does_not_mask_input_validation_errors():
    model = DashboardReadModel(_DownRepository(), freshness_threshold=timedelta(minutes=5))
    with pytest.raises(ValueError):
        await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10_001)
