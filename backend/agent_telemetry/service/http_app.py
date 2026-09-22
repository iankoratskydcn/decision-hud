"""Minimal loopback-only HTTP service exposing GET /decision-hud/agent-dashboard.

Built on stdlib `http.server` only (no new runtime dependency). Binds
strictly to 127.0.0.1 by design — `build_server()` raises if asked to bind
anything else, per the loopback-only requirement in the owner decision
record and the security review.

Auth flow per request:
  1. Extract `project_id` from the query string (required).
  2. Extract the bearer token from `Authorization: Bearer <token>`.
  3. `service.auth.authenticate_project_request(token, project_id)`:
       - missing/invalid/expired token -> Unauthorized -> HTTP 401
       - valid token, mismatched project claim -> Forbidden -> HTTP 403
       - success -> returns actor identity (logged, not returned to client)
  4. On success, call `DashboardReadModel.status(scope=project_id, ...)`
     using the AUTHENTICATED project_id — never any client-suppliable
     `scope` query override — and serialize the result as JSON with 200.

This service is intentionally synchronous at the transport layer
(`http.server.ThreadingHTTPServer`) and bridges to the async
`DashboardReadModel.status()` with a private event loop per request
(`asyncio.run`), since stdlib's server is sync and adding an async web
framework was out of scope for this minimal slice.
"""
from __future__ import annotations

import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from agent_telemetry.service.auth import Forbidden, Unauthorized, authenticate_project_request

_ROUTE_PATH = "/decision-hud/agent-dashboard"
# Wave 2d: cost/quality/speed comparison panel, fed by Wave 1d's
# CrossSourceComparison read model. A sibling route, not a query param on
# _ROUTE_PATH, since its payload shape (rows + derived metrics) is
# unrelated to DashboardStatus.to_dict() and it is intentionally NOT
# project-scoped (see CrossSourceComparison/query_by_producer docstrings —
# kanban-sync and sidecars rows live under different `scope` values, so
# there is no single project scope to filter comparison rows by). Auth
# still requires a valid project-scoped actor token (proves the caller is
# an authenticated dashboard user), it just isn't used to filter this
# route's data the way it filters _ROUTE_PATH's.
_COMPARISON_ROUTE_PATH = "/decision-hud/agent-dashboard/comparison"
_MAX_LIMIT_DEFAULT = 1000
_DEFAULT_BASELINE_PATH = "baseline"


def _run_async(coro):
    import asyncio

    return asyncio.run(coro)


def _make_handler(read_model, comparison=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AgentDashboardHTTP/1"

        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            pass  # keep test output quiet; real deployments can wire logging.Handler here

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _bearer_token(self):
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return None
            token = header[len("Bearer "):].strip()
            return token or None

        def _authenticate(self, project_id):
            """Shared by both routes: validate the bearer token against
            `project_id`, sending the matching error response and returning
            False on failure so callers can `return` immediately."""
            token = self._bearer_token()
            try:
                authenticate_project_request(token, project_id)
            except Unauthorized as exc:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": str(exc)})
                return False
            except Forbidden as exc:
                self._send_json(HTTPStatus.FORBIDDEN, {"error": str(exc)})
                return False
            return True

        def do_GET(self):  # noqa: N802 - stdlib method name
            parsed = urlsplit(self.path)
            if parsed.path == _COMPARISON_ROUTE_PATH:
                self._handle_comparison(parse_qs(parsed.query))
                return
            if parsed.path != _ROUTE_PATH:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            query = parse_qs(parsed.query)
            project_ids = query.get("project_id")
            project_id = project_ids[0] if project_ids else None
            if not project_id:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "project_id query parameter is required"})
                return
            if not self._authenticate(project_id):
                return

            agent_ids = query.get("agent_ids", [])
            # Split on commas too so ?agent_ids=a,b or repeated params both work.
            flat_agent_ids = []
            for raw in agent_ids:
                flat_agent_ids.extend(part for part in raw.split(",") if part)
            limit_values = query.get("limit")
            try:
                limit = int(limit_values[0]) if limit_values else _MAX_LIMIT_DEFAULT
            except ValueError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return

            try:
                # AUTHENTICATED project_id only — any client-supplied `scope`
                # query parameter is ignored deliberately (defense in depth).
                status = _run_async(
                    read_model.status(scope=project_id, agent_ids=flat_agent_ids, limit=limit)
                )
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return

            self._send_json(HTTPStatus.OK, status.to_dict())

        def _handle_comparison(self, query):
            if comparison is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            # This route is not project-scoped (see _COMPARISON_ROUTE_PATH
            # comment), but still requires *a* valid, non-expired actor
            # token bound to *some* project — any authenticated dashboard
            # user's own project_id proves that, so reuse it as the
            # authentication project claim without leaking cross-project
            # comparison data (there is none; rows are producer-tagged, not
            # project-tagged).
            project_ids = query.get("project_id")
            project_id = project_ids[0] if project_ids else None
            if not project_id:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "project_id query parameter is required"})
                return
            if not self._authenticate(project_id):
                return
            limit_values = query.get("limit")
            try:
                limit = int(limit_values[0]) if limit_values else _MAX_LIMIT_DEFAULT
            except ValueError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                return
            baseline_values = query.get("baseline_path")
            baseline_path = baseline_values[0] if baseline_values else _DEFAULT_BASELINE_PATH
            try:
                payload = _run_async(comparison.status(limit=limit, baseline_path=baseline_path))
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, payload)

    return Handler


class LoopbackOnlyServer(ThreadingHTTPServer):
    allow_reuse_address = True


def build_server(repository, *, host: str = "127.0.0.1", port: int = 0, read_model=None, comparison=None):
    """Build (but do not start) the HTTP server. `repository` is anything
    matching PostgresMetricsRepository's `query_recent_metrics` shape
    (DashboardReadModel's dependency); `read_model` may be supplied directly
    for tests, otherwise one is constructed around `repository`. `comparison`
    (a `CrossSourceComparison`, Wave 1d) is optional — omitting it 404s
    `_COMPARISON_ROUTE_PATH` rather than fabricating panel data; callers
    that want the Wave 2d panel pass one built around the same `repository`
    (it uses `query_by_producer`, a separate read path from
    `query_recent_metrics`)."""
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            f"agent-dashboard HTTP service is loopback-only by design; refusing to bind host={host!r}"
        )
    if read_model is None:
        from agent_telemetry.dashboard.read_model import DashboardReadModel

        read_model = DashboardReadModel(repository)
    handler_cls = _make_handler(read_model, comparison)
    server = LoopbackOnlyServer((host, port), handler_cls)
    return server


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    return thread


def stop_server(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def main() -> None:  # pragma: no cover - manual/local run entrypoint
    import os

    database_url = os.environ.get("DASHBOARD_DATABASE_URL")
    if not database_url:
        raise SystemExit("DASHBOARD_DATABASE_URL is required to run the agent-dashboard HTTP service")
    from agent_telemetry.db.postgres import PostgresMetricsRepository

    repository = PostgresMetricsRepository(database_url)
    _run_async(repository.open())
    from agent_telemetry.dashboard.comparison import CrossSourceComparison

    comparison = CrossSourceComparison(repository)
    server = build_server(
        repository, host="127.0.0.1", port=int(os.environ.get("DASHBOARD_HTTP_PORT", "8787")), comparison=comparison
    )
    print(f"agent-dashboard HTTP service listening on http://127.0.0.1:{server.server_address[1]}{_ROUTE_PATH}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        _run_async(repository.close())


if __name__ == "__main__":  # pragma: no cover
    main()
