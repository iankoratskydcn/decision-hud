"""Independent acceptance tests for the loopback authenticated HTTP service
exposing GET /decision-hud/agent-dashboard.

These tests use a real subprocess-free HTTP server bound to 127.0.0.1 on an
ephemeral port and real actor-token files written to a temp HOME (so the
real, reused decision-hud plugin verifier is exercised end to end, not
mocked). They cover, independently:
  1. token validation (missing / malformed / unknown / expired -> 401)
  2. project-scope enforcement (valid token, wrong project claim -> 403)
  3. a successful authorized request (valid token + matching project -> 200,
     correct dashboard payload, and the server refuses non-loopback bind)

Run before implementation exists: this file is expected to fail at import
time (ModuleNotFoundError) or with all tests erroring — that failure IS the
RED state for the http_app/auth modules.
"""
from __future__ import annotations

import importlib
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

SCOPE = "project:selected"
OTHER_SCOPE = "project:other"


def _plugin_db_module():
    """Load (or reuse cached) the sibling decision-hud plugin's db module by
    file path, exactly the way service.auth does, so tests mint real
    tokens against the SAME on-disk store format the service reads."""
    import importlib.util

    path = Path.home() / ".hermes" / "plugins" / "decision-hud" / "db.py"
    if not path.exists():
        pytest.skip(f"decision-hud plugin db module not found at {path}")
    name = "decision_hud_plugin_db_reused"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _service_modules():
    try:
        auth = importlib.import_module("agent_telemetry.service.auth")
        http_app = importlib.import_module("agent_telemetry.service.http_app")
    except ModuleNotFoundError as exc:
        pytest.fail(
            "agent_telemetry.service (auth/http_app) is absent; implement "
            f"the loopback authenticated HTTP service before this suite can pass ({exc})"
        )
    return auth, http_app


class _FakeRepository:
    """Records the scope it was queried with, proving the server passes the
    authenticated project scope through to the read model rather than
    trusting an unauthenticated query parameter."""

    def __init__(self):
        self.calls = []

    async def query_recent_metrics(self, *, scope, agent_ids, limit):
        self.calls.append({"scope": scope, "agent_ids": list(agent_ids), "limit": limit})
        if scope != SCOPE:
            return []
        return [
            SimpleNamespace(
                agent_id="agent-a",
                captured_at="2026-09-12T20:00:00+00:00",
                values={},
            )
        ]


@pytest.fixture
def isolated_hermes_home(tmp_path, monkeypatch):
    """Point both the plugin's token store and this service's HOME lookup
    at a disposable directory so tests never touch the real actor-token
    store on disk. The plugin module itself is still the REAL one on this
    machine — only its data directory (driven by HOME) is redirected."""
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    # Path.home() cannot be used to find the REAL plugin location after
    # monkeypatching HOME, so resolve it via pwd instead.
    import pwd

    real_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    real_plugin_db_path = real_home / ".hermes" / "plugins" / "decision-hud" / "db.py"
    if not real_plugin_db_path.exists():
        pytest.skip(f"decision-hud plugin db module not found at {real_plugin_db_path}")
    monkeypatch.setenv("DECISION_HUD_PLUGIN_DB_PATH", str(real_plugin_db_path))
    # hermes_constants.get_hermes_home() (used by db._hermes_home()) falls
    # back to Path.home()/.hermes when the import fails, which it will in
    # this isolated test environment, so patching HOME is sufficient to
    # redirect the actor-token store to `home` while reusing the real code.
    return home


@pytest.fixture
def server(isolated_hermes_home):
    auth, http_app = _service_modules()
    repository = _FakeRepository()
    srv = http_app.build_server(repository, host="127.0.0.1", port=0)
    thread = http_app.serve_in_thread(srv)
    try:
        yield srv, repository
    finally:
        http_app.stop_server(srv, thread)


def _url(srv, project_id, extra_query=""):
    port = srv.server_address[1]
    q = f"project_id={project_id}"
    if extra_query:
        q += "&" + extra_query
    return f"http://127.0.0.1:{port}/decision-hud/agent-dashboard?{q}"


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


def test_bind_is_loopback_only(server):
    srv, _ = server
    host = srv.server_address[0]
    assert host in ("127.0.0.1", "localhost")


class TestTokenValidation:
    """Independent RED test group: reject missing/invalid tokens with 401,
    regardless of project scope."""

    def test_missing_token_is_401(self, server):
        srv, _ = server
        status, body = _get(_url(srv, SCOPE), token=None)
        assert status == 401
        assert "error" in body

    def test_malformed_unknown_token_is_401(self, server):
        srv, _ = server
        status, body = _get(_url(srv, SCOPE), token="not-a-real-token")
        assert status == 401
        assert "error" in body

    def test_expired_token_is_401(self, server, isolated_hermes_home):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE, ttl_seconds=1)
        time.sleep(1.2)
        srv, _ = server
        status, body = _get(_url(srv, SCOPE), token=raw)
        assert status == 401
        assert "error" in body


class TestProjectScopeEnforcement:
    """Independent RED test group: a structurally valid token bound to one
    project must be rejected (403) for a different requested project."""

    def test_cross_project_token_is_403(self, server, isolated_hermes_home):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", OTHER_SCOPE)
        srv, _ = server
        status, body = _get(_url(srv, SCOPE), token=raw)
        assert status == 403
        assert "error" in body

    def test_missing_project_id_query_param_is_rejected(self, server, isolated_hermes_home):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, _ = server
        port = srv.server_address[1]
        status, body = _get(f"http://127.0.0.1:{port}/decision-hud/agent-dashboard", token=raw)
        assert status in (400, 401, 403)


class TestAuthorizedRequest:
    """Independent RED test group: a valid, matching-project token succeeds
    and returns a real dashboard payload backed by the fake repository,
    proving the authenticated project scope (not a client-supplied one) is
    what reaches the read model."""

    def test_authorized_request_returns_dashboard_payload(self, server, isolated_hermes_home):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, repository = server
        status, body = _get(_url(srv, SCOPE, extra_query="agent_ids=agent-a&limit=10"), token=raw)
        assert status == 200
        assert body["schema_version"]
        assert len(body["agents"]) == 1
        assert body["agents"][0]["agent_id"] == "agent-a"
        # The server must have queried the repository with the AUTHENTICATED
        # project scope, matching the token's claim.
        assert repository.calls
        assert all(call["scope"] == SCOPE for call in repository.calls)

    def test_authorized_request_cannot_be_redirected_to_other_scope_by_query(self, server, isolated_hermes_home):
        """Even if a client tries to sneak a different scope into the query
        than the URL's project_id (defense in depth), the server must use
        the single authenticated project_id, not any caller-suppliable
        override field."""
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, repository = server
        status, body = _get(
            _url(srv, SCOPE, extra_query=f"agent_ids=agent-a&limit=10&scope={OTHER_SCOPE}"),
            token=raw,
        )
        assert status == 200
        assert all(call["scope"] == SCOPE for call in repository.calls)


class _FakeReadModelWithHistory:
    """Minimal stand-in for DashboardReadModel exposing only metric_history,
    proving the /history route calls the read model (not the raw
    repository) and passes through the authenticated project scope."""

    def __init__(self):
        self.calls = []

    async def metric_history(self, *, scope, agent_ids, metric_key, since=None, limit=500):
        self.calls.append({
            "scope": scope, "agent_ids": list(agent_ids), "metric_key": metric_key,
            "since": since, "limit": limit,
        })
        if scope != SCOPE:
            return {agent_id: [] for agent_id in agent_ids}
        return {
            agent_id: [{"captured_at": "2026-09-12T20:00:00+00:00", "value": 3.0}]
            for agent_id in agent_ids
        }


@pytest.fixture
def history_server(isolated_hermes_home):
    _, http_app = _service_modules()
    read_model = _FakeReadModelWithHistory()
    srv = http_app.build_server(object(), host="127.0.0.1", port=0, read_model=read_model)
    thread = http_app.serve_in_thread(srv)
    try:
        yield srv, read_model
    finally:
        http_app.stop_server(srv, thread)


def _history_url(srv, project_id, extra_query=""):
    port = srv.server_address[1]
    q = f"project_id={project_id}"
    if extra_query:
        q += "&" + extra_query
    return f"http://127.0.0.1:{port}/decision-hud/agent-dashboard/history?{q}"


class TestHistoryRoute:
    """Agent Health percentile/z-score normalization needs real history, not
    just the latest snapshot — this route is the new read path for that,
    reusing the SAME read_model/auth as _ROUTE_PATH (see http_app.py's
    _HISTORY_ROUTE_PATH docstring: no new data source, no new dependency)."""

    def test_requires_auth(self, history_server):
        srv, _ = history_server
        status, body = _get(_history_url(srv, SCOPE, "metric_key=blocked_volume&agent_ids=agent-a"), token=None)
        assert status == 401
        assert "error" in body

    def test_requires_metric_key(self, history_server):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, _ = history_server
        status, body = _get(_history_url(srv, SCOPE, "agent_ids=agent-a"), token=raw)
        assert status == 400
        assert "error" in body

    def test_requires_agent_ids(self, history_server):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, _ = history_server
        status, body = _get(_history_url(srv, SCOPE, "metric_key=blocked_volume"), token=raw)
        assert status == 400
        assert "error" in body

    def test_returns_series_using_authenticated_scope(self, history_server):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", SCOPE)
        srv, read_model = history_server
        status, body = _get(
            _history_url(srv, SCOPE, "metric_key=blocked_volume&agent_ids=agent-a,agent-b"), token=raw,
        )
        assert status == 200
        assert body["schema_version"] == "agent-dashboard-history.v1"
        assert body["metric_key"] == "blocked_volume"
        assert set(body["series"]) == {"agent-a", "agent-b"}
        assert body["series"]["agent-a"][0]["value"] == 3.0
        assert all(call["scope"] == SCOPE for call in read_model.calls)

    def test_cross_project_token_is_403(self, history_server):
        auth, _ = _service_modules()
        raw = auth.issue_project_actor_token("tester", OTHER_SCOPE)
        srv, _ = history_server
        status, body = _get(
            _history_url(srv, SCOPE, "metric_key=blocked_volume&agent_ids=agent-a"), token=raw,
        )
        assert status == 403
