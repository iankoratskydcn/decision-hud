"""Acceptance tests for the dashboard review blockers.

These tests cover only interfaces established by the decision record and the
existing plugin/read-model boundary. The HTTP actor-token service test is
intentionally not guessed here: no service module, route, or token-verifier
interface exists in the repository, so that blocker is recorded in the repair
report instead of creating a false contract.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from agent_dashboard.dashboard.read_model import DashboardReadModel
from agent_dashboard.db.postgres import PostgresMetricsRepository
from agent_dashboard.domain.contracts import MetricValue


SCOPE = "project:selected"


def _metric_value(raw_value: object = 12.5) -> MetricValue:
    return MetricValue(
        raw_value=raw_value,
        value_type="number",
        unit="tokens/min",
        category="resource",
    )


class _ReadModelRepository:
    async def query_recent_metrics(self, *, scope, agent_ids, limit):
        assert scope == SCOPE
        assert agent_ids == ["agent-a"]
        assert limit == 10
        return [
            SimpleNamespace(
                agent_id="agent-a",
                captured_at="2026-09-12T20:00:00+00:00",
                values={"token_burn_rate": _metric_value()},
            )
        ]


@pytest.mark.asyncio
async def test_read_model_serializes_exact_plugin_v1_contract():
    model = DashboardReadModel(_ReadModelRepository())

    response = await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10)
    serialized = response.to_dict()

    assert set(serialized) == {
        "schema_version",
        "scope",
        "freshness",
        "agents",
        "metrics",
    }
    assert serialized["schema_version"] == "dashboard-read-model.v1"
    assert serialized["scope"] == {
        "project_id": SCOPE,
        "project_label": SCOPE,
    }
    assert serialized["freshness"]["state"] == "fresh"
    assert isinstance(serialized["freshness"]["as_of"], str)
    assert serialized["agents"] == [
        {"agent_id": "agent-a", "label": "agent-a", "status": "running"}
    ]
    assert serialized["metrics"] == [
        {
            "key": "token_burn_rate",
            "label": "token_burn_rate",
            "value": 12.5,
            "unit": "tokens/min",
            "source_window": "telemetry",
            "freshness": "fresh",
        }
    ]


@pytest.mark.asyncio
async def test_read_model_rejects_unbounded_request_and_agent_list():
    model = DashboardReadModel(_ReadModelRepository())

    with pytest.raises(ValueError):
        await model.status(scope=SCOPE, agent_ids=["agent-a"], limit=10_001)
    with pytest.raises(ValueError):
        await model.status(
            scope=SCOPE,
            agent_ids=[f"agent-{index}" for index in range(11)],
            limit=10,
        )


@pytest.fixture
async def repository():
    database_url = os.environ.get("DASHBOARD_TEST_DATABASE_URL")
    if not database_url:
        pytest.fail(
            "DASHBOARD_TEST_DATABASE_URL is required: PostgreSQL integration "
            "must not be skipped"
        )
    repository = PostgresMetricsRepository(database_url)
    await repository.open()
    await repository.migrate()
    yield repository
    await repository.close()


def _snapshot(*, key: str) -> dict:
    now = datetime(2026, 9, 12, 20, 0, tzinfo=timezone.utc)
    timestamp = now.isoformat().replace("+00:00", "Z")
    return {
        "schema_version": "telemetry.v1",
        "event_id": str(uuid4()),
        "producer": "acceptance",
        "producer_instance_id": "repair-tests",
        "occurred_at": timestamp,
        "received_at": timestamp,
        "agent_id": "agent-a",
        "run_id": str(uuid4()),
        "task_id": str(uuid4()),
        "task_type": "acceptance",
        "scope": SCOPE,
        "provenance": "acceptance",
        "idempotency_key": key,
        "source": "checkpoint",
        "authoritative": False,
        "completeness": "partial",
        "captured_at": timestamp,
        "values": {
            "token_burn_rate": {
                "raw_value": 12.5,
                "value_type": "number",
                "unit": "tokens/min",
                "category": "resource",
            }
        },
        "quality_flags": [],
    }


@pytest.mark.asyncio
async def test_repository_commits_reads_and_survives_close_reopen(repository):
    await repository.write_checkpoint(_snapshot(key="before-read"))
    first_read = await repository.query_recent_metrics(
        scope=SCOPE, agent_ids=["agent-a"], limit=10
    )
    assert len(first_read) == 1

    # A read must not leave an open transaction that prevents the next write
    # from being committed durably.
    await repository.write_checkpoint(_snapshot(key="after-read"))
    await repository.close()
    await repository.open()

    rows = await repository.query_recent_metrics(
        scope=SCOPE, agent_ids=["agent-a"], limit=10
    )
    assert {row.idempotency_key for row in rows} == {"before-read", "after-read"}
