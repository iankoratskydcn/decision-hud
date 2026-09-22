"""Wave 2d: HTTP route exposing the Wave 1d CrossSourceComparison panel.

Independent focused test file (per-card discipline). Reuses the same real
subprocess-free server + real actor-token fixtures as
test_agent_dashboard_http_service.py rather than re-deriving auth from
scratch — this route shares `authenticate_project_request`.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SCOPE = "project:selected"


def _service_modules():
    auth = importlib.import_module("agent_telemetry.service.auth")
    http_app = importlib.import_module("agent_telemetry.service.http_app")
    comparison_module = importlib.import_module("agent_telemetry.dashboard.comparison")
    return auth, http_app, comparison_module


class _FakeReadModel:
    async def status(self, **kwargs):  # pragma: no cover - unused by this route's tests
        raise AssertionError("comparison route must not touch the dashboard read model")


class _FakeComparisonRepository:
    """Stub matching CrossSourceComparison's `query_by_producer` dependency."""

    def __init__(self, rows_by_producer):
        self._rows_by_producer = rows_by_producer

    async def query_by_producer(self, *, producer, limit=500):
        return self._rows_by_producer.get(producer, [])[:limit]


def _kanban_snapshot(contracts, *, agent_id="alice", input_tokens=1000, output_tokens=200):
    from datetime import datetime, timezone
    from uuid import uuid4

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return contracts.MetricSnapshot.from_dict({
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


def _sidecar_snapshot(contracts, *, operation="op-a", execution_path="sidecar_active", input_tokens=100, output_tokens=20, latency_ms=250.0):
    from datetime import datetime, timezone
    from uuid import uuid4

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return contracts.MetricSnapshot.from_dict({
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


@pytest.fixture
def isolated_hermes_home(tmp_path, monkeypatch):
    import os
    import pwd

    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    real_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    real_plugin_db_path = real_home / ".hermes" / "plugins" / "decision-hud" / "db.py"
    if not real_plugin_db_path.exists():
        pytest.skip(f"decision-hud plugin db module not found at {real_plugin_db_path}")
    monkeypatch.setenv("DECISION_HUD_PLUGIN_DB_PATH", str(real_plugin_db_path))
    return home


@pytest.fixture
def server_with_comparison(isolated_hermes_home):
    auth, http_app, comparison_module = _service_modules()
    from agent_telemetry.domain import contracts

    rows_by_producer = {
        "kanban-sync": [_kanban_snapshot(contracts, agent_id="alice", input_tokens=1000, output_tokens=200)],
        "sidecars": [_sidecar_snapshot(contracts, operation="op-a", input_tokens=100, output_tokens=20, latency_ms=250.0)],
    }
    repository = _FakeComparisonRepository(rows_by_producer)
    comparison = comparison_module.CrossSourceComparison(repository)
    srv = http_app.build_server(object(), host="127.0.0.1", port=0, read_model=_FakeReadModel(), comparison=comparison)
    thread = http_app.serve_in_thread(srv)
    try:
        yield srv, auth
    finally:
        http_app.stop_server(srv, thread)


def _get(url, token=None):
    req = urllib.request.Request(url, method="GET")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {"raw": body}
        return exc.code, payload


def _comparison_url(srv, project_id, extra_query=""):
    port = srv.server_address[1]
    q = f"project_id={project_id}"
    if extra_query:
        q += "&" + extra_query
    return f"http://127.0.0.1:{port}/decision-hud/agent-dashboard/comparison?{q}"


def test_comparison_route_requires_auth(server_with_comparison):
    srv, _ = server_with_comparison
    status, body = _get(_comparison_url(srv, SCOPE), token=None)
    assert status == 401
    assert "error" in body


def test_comparison_route_returns_producer_tagged_rows_and_derived_metrics(server_with_comparison):
    srv, auth = server_with_comparison
    raw = auth.issue_project_actor_token("tester", SCOPE)
    status, body = _get(_comparison_url(srv, SCOPE), token=raw)
    assert status == 200
    assert body["schema_version"] == "agent-dashboard-comparison.v1"
    producers = {row["producer"] for row in body["rows"]}
    assert producers == {"kanban-sync", "sidecars"}
    # kanban and sidecar rows are joinable but never blended into one row.
    for row in body["rows"]:
        if row["producer"] == "kanban-sync":
            assert row["path"] == "kanban_agent"
        else:
            assert row["path"] == "sidecar_active"
        assert row["quality_score"] is None  # never fabricated
    assert "sidecar_active" in body["comparisons"]
    assert "kanban_agent" in body["comparisons"]


def test_comparison_route_respects_baseline_path_query(server_with_comparison):
    srv, auth = server_with_comparison
    raw = auth.issue_project_actor_token("tester", SCOPE)
    status, body = _get(_comparison_url(srv, SCOPE, extra_query="baseline_path=kanban_agent"), token=raw)
    assert status == 200
    assert body["baseline_path"] == "kanban_agent"
    assert "kanban_agent" not in body["comparisons"]  # baseline itself is excluded from active paths
    assert "sidecar_active" in body["comparisons"]


def test_comparison_route_404s_without_a_comparison_dependency(isolated_hermes_home):
    auth, http_app, _ = _service_modules()
    srv = http_app.build_server(object(), host="127.0.0.1", port=0, read_model=_FakeReadModel())
    thread = http_app.serve_in_thread(srv)
    try:
        raw = auth.issue_project_actor_token("tester", SCOPE)
        status, body = _get(_comparison_url(srv, SCOPE), token=raw)
        assert status == 404
    finally:
        http_app.stop_server(srv, thread)
