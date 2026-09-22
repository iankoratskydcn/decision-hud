"""Read-only Agent Dashboard API for the Decision HUD desktop pane."""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query

router = APIRouter()
log = logging.getLogger(__name__)

_BACKEND = Path.home() / ".hermes" / "desktop-plugins" / "decision-hud" / "backend"
# backend/agent_dashboard was renamed to backend/agent_telemetry (see
# AGENT_DASHBOARD_CONSOLIDATION_PLAN.md Wave 0 step 1) — this constant and
# _load_read_model()'s imports below must track that rename or every
# request 500s with an ImportError swallowed by the broad except Exception
# at the bottom of agent_dashboard(), surfacing as a misleading generic
# "Agent Dashboard backend unavailable" 503 with no hint the real cause is
# a stale module path, not Postgres being down.
_AUTH_PATH = _BACKEND / "agent_telemetry" / "service" / "auth.py"


def _load_auth():
    # The backend is a standalone user plugin checkout, not an installed package.
    backend = str(_BACKEND)
    if backend not in sys.path:
        sys.path.insert(0, backend)
    name = "decision_hud_dashboard_auth"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, _AUTH_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"agent-dashboard auth module unavailable: {_AUTH_PATH}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def _load_read_model():
    backend = str(_BACKEND)
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from agent_telemetry.dashboard.read_model import DashboardReadModel
    from agent_telemetry.db.postgres import PostgresMetricsRepository

    database_url = os.environ.get(
        "DASHBOARD_DATABASE_URL",
        "postgresql://dashboard:dashboard@127.0.0.1:55432/dashboard",
    )
    return PostgresMetricsRepository(database_url), DashboardReadModel


@router.get("/agent-dashboard")
async def agent_dashboard(
    project_id: str | None = Query(default=None),
    limit: int = Query(1000),
    agent_ids: list[str] = Query(default=[]),
    authorization: str | None = Header(default=None),
):
    """Return the authenticated project's read-only telemetry snapshot."""
    log.info("agent-dashboard request: project_id=%r limit=%r agent_ids=%r has_auth=%s",
              project_id, limit, agent_ids, bool(authorization))
    if not project_id:
        log.warning("agent-dashboard 422: project_id missing from query string")
        raise HTTPException(status_code=422, detail="project_id query parameter is required")
    if not authorization or not authorization.startswith("Bearer "):
        log.warning("agent-dashboard 401: missing/malformed Authorization header")
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = authorization[len("Bearer "):].strip()
    try:
        auth = _load_auth()
        auth.authenticate_project_request(token, project_id)
        repository, read_model_type = _load_read_model()
        await repository.open()
        try:
            # The desktop pane has no independent roster of agent_ids for a
            # project (unlike kanban, telemetry has no separate "assignees"
            # list) — discover which agents have ever reported here first,
            # rather than silently returning zero agents for the common case
            # of an empty `agent_ids` query param. An explicit non-empty
            # `agent_ids` still bypasses discovery and is honored as-is.
            effective_agent_ids = agent_ids
            if not effective_agent_ids:
                effective_agent_ids = await repository.list_scope_agent_ids(scope=project_id, limit=limit)
            result = await read_model_type(repository).status(
                scope=project_id, agent_ids=effective_agent_ids, limit=limit
            )
            log.info("agent-dashboard ok: project_id=%r agents=%d", project_id, len(effective_agent_ids))
            return result.to_dict()
        finally:
            await repository.close()
    except Exception as exc:
        # Preserve deliberate HTTP auth/status responses; do not leak internals.
        if isinstance(exc, HTTPException):
            log.warning("agent-dashboard %s: project_id=%r detail=%r", exc.status_code, project_id, exc.detail)
            raise
        name = type(exc).__name__
        log.error("agent-dashboard error: project_id=%r %s: %s", project_id, name, exc, exc_info=True)
        if name == "Unauthorized":
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        if name == "Forbidden":
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        if name == "ValueError":
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise HTTPException(status_code=503, detail="Agent Dashboard backend unavailable") from exc
