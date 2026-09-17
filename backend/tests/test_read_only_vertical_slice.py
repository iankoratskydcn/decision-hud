"""Independent acceptance tests for the first dashboard backend slice.

These tests intentionally use the public domain/repository/read-model boundary.
They do not mock PostgreSQL or assert SQL/ORM implementation details.
"""

from __future__ import annotations

import importlib
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest


SCOPE = "project:test-selected"
OTHER_SCOPE = "project:test-other"


def _contract():
    """Load the intended contract and turn absence into a diagnostic RED failure."""
    try:
        contracts = importlib.import_module("agent_dashboard.domain.contracts")
        postgres = importlib.import_module("agent_dashboard.db.postgres")
        read_model = importlib.import_module("agent_dashboard.dashboard.read_model")
    except ModuleNotFoundError as exc:
        pytest.fail(
            "backend contract is absent; implement agent_dashboard domain, "
            f"PostgreSQL repository, and read model before running this suite ({exc})"
        )
    for module, names in (
        (contracts, ("MetricSnapshot",)),
        (postgres, ("PostgresMetricsRepository",)),
        (read_model, ("DashboardReadModel",)),
    ):
        missing = [name for name in names if not hasattr(module, name)]
        if missing:
            pytest.fail(f"backend contract is absent: {module.__name__} lacks {missing}")
    return contracts.MetricSnapshot, postgres.PostgresMetricsRepository, read_model.DashboardReadModel


def _snapshot_payload(*, scope=SCOPE, captured_at=None, key=None, agent="agent-a"):
    now = captured_at or datetime.now(timezone.utc)
    return {
        "schema_version": "telemetry.v1",
        "event_id": str(uuid4()),
        "producer": "reporter",
        "producer_instance_id": "test-reporter",
        "occurred_at": now.isoformat().replace("+00:00", "Z"),
        "received_at": now.isoformat().replace("+00:00", "Z"),
        "agent_id": agent,
        "run_id": str(uuid4()),
        "task_id": str(uuid4()),
        "task_type": "acceptance",
        "scope": scope,
        "provenance": "reporter",
        "idempotency_key": key or str(uuid4()),
        "source": "checkpoint",
        "authoritative": False,
        "completeness": "partial",
        "captured_at": now.isoformat().replace("+00:00", "Z"),
        "values": {
            "token_burn_rate": {"raw_value": 12.5, "value_type": "number", "unit": "tokens/min", "category": "resource"},
            "context_utilization": {"raw_value": 0.42, "value_type": "number", "unit": "ratio", "category": "resource"},
        },
        "quality_flags": [],
    }


@pytest.fixture
def contract():
    return _contract()


@pytest.fixture
def postgres_url():
    value = os.environ.get("DASHBOARD_TEST_DATABASE_URL")
    if not value:
        pytest.fail("DASHBOARD_TEST_DATABASE_URL is required: PostgreSQL integration must not be skipped")
    return value


@pytest.fixture
async def repository(contract, postgres_url):
    _, repository_type, _ = contract
    repository = repository_type(postgres_url)
    await repository.open()
    await repository.migrate()
    yield repository
    await repository.close()


def test_metric_snapshot_rejects_unknown_fields_and_round_trips_losslessly(contract):
    snapshot_type, _, _ = contract
    payload = _snapshot_payload()
    snapshot = snapshot_type.from_dict(payload)
    assert snapshot.to_dict() == payload
    with pytest.raises((ValueError, TypeError)):
        snapshot_type.from_dict({**payload, "unexpected": True})


@pytest.mark.asyncio
async def test_checkpoint_duplicate_is_idempotent_and_conflict_is_rejected(repository):
    payload = _snapshot_payload(key="checkpoint-1")
    first = await repository.write_checkpoint(payload)
    replay = await repository.write_checkpoint(payload)
    assert replay.record_id == first.record_id
    assert replay.replayed is True
    assert await repository.count_snapshots(scope=SCOPE, idempotency_key="checkpoint-1") == 1

    conflicting = {**payload, "values": {**payload["values"], "token_burn_rate": {**payload["values"]["token_burn_rate"], "raw_value": 99}}}
    with pytest.raises((ValueError, RuntimeError)):
        await repository.write_checkpoint(conflicting)
    assert await repository.count_snapshots(scope=SCOPE, idempotency_key="checkpoint-1") == 1


@pytest.mark.asyncio
async def test_postgres_round_trip_query_is_durable_and_selected_project_scoped(repository):
    selected = _snapshot_payload(key="selected", scope=SCOPE)
    other = _snapshot_payload(key="other", scope=OTHER_SCOPE, agent="agent-other")
    await repository.write_checkpoint(selected)
    await repository.write_checkpoint(other)

    rows = await repository.query_recent_metrics(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    assert len(rows) == 1
    assert rows[0].scope == SCOPE
    assert rows[0].agent_id == "agent-a"
    assert rows[0].values["token_burn_rate"].raw_value == 12.5
    assert all(row.scope == SCOPE for row in rows)


@pytest.mark.asyncio
async def test_dashboard_read_model_is_bounded_and_has_freshness_and_missing_states(repository, contract):
    _, _, read_model_type = contract
    now = datetime.now(timezone.utc)
    await repository.write_checkpoint(_snapshot_payload(key="fresh", captured_at=now, scope=SCOPE))
    await repository.write_checkpoint(_snapshot_payload(key="stale", captured_at=now - timedelta(hours=2), scope=SCOPE, agent="agent-stale"))

    model = read_model_type(repository, freshness_threshold=timedelta(minutes=5))
    response = await model.status(scope=SCOPE, agent_ids=["agent-a", "agent-missing", "agent-stale"], limit=10)
    assert response.schema_version == "dashboard.read-model.v1"
    assert len(response.agents) == 3
    by_agent = {agent.agent_id: agent for agent in response.agents}
    assert by_agent["agent-a"].freshness.state == "fresh"
    assert by_agent["agent-a"].freshness.observed_at is not None
    assert by_agent["agent-stale"].freshness.state == "stale"
    assert by_agent["agent-missing"].freshness.state == "missing"
    assert by_agent["agent-missing"].metrics == {}


@pytest.mark.asyncio
async def test_dashboard_read_model_never_falls_back_across_projects(repository, contract):
    _, _, read_model_type = contract
    await repository.write_checkpoint(_snapshot_payload(key="other-only", scope=OTHER_SCOPE, agent="agent-a"))
    model = read_model_type(repository, freshness_threshold=timedelta(minutes=5))
    response = await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    assert len(response.agents) == 1
    assert response.agents[0].freshness.state == "missing"
    assert response.agents[0].metrics == {}


@pytest.mark.asyncio
async def test_read_model_rejects_unbounded_limit(repository, contract):
    _, _, read_model_type = contract
    model = read_model_type(repository)
    with pytest.raises((ValueError, TypeError)):
        await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10001)


@pytest.mark.asyncio
async def test_list_scope_agent_ids_discovers_reporters_scoped_and_deduped(repository, contract):
    """Regression guard: the desktop pane has no independent agent roster for
    telemetry (unlike kanban's assignees list), so `status(agent_ids=[])`
    alone always returns zero agents even when the scope has real data. The
    HTTP endpoint must call this discovery query first when the caller sent
    no explicit agent_ids."""
    await repository.write_checkpoint(_snapshot_payload(key="a1", agent="agent-a"))
    await repository.write_checkpoint(_snapshot_payload(key="a2", agent="agent-a"))  # same agent, must dedupe
    await repository.write_checkpoint(_snapshot_payload(key="b1", agent="agent-b"))
    await repository.write_checkpoint(_snapshot_payload(key="other-scope", scope=OTHER_SCOPE, agent="agent-c"))

    discovered = await repository.list_scope_agent_ids(scope=SCOPE)
    assert sorted(discovered) == ["agent-a", "agent-b"]  # deduped, scoped, agent-c excluded

    empty = await repository.list_scope_agent_ids(scope="project:nothing-here")
    assert empty == []
