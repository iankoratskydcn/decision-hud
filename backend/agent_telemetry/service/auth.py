"""Actor-token + project-claim gate for the agent dashboard HTTP service.

Design (owner decision, docs/agent-dashboard-decision-record.md): "reuse
existing Decision HUD actor tokens for telemetry reads ..., extended with
explicit project claims. No anonymous fallback." Concretely, that means:

  - Minting and validating the underlying actor-token record (hash, TTL,
    expiry-driven cleanup) is REUSED by importing the real implementation
    from the sibling `decision-hud` plugin's `db.py`
    (`~/.hermes/plugins/decision-hud/db.py`): `issue_actor_token` and
    `_validate_actor_token`. This service never re-derives token hashing or
    expiry logic — it calls the real functions.
  - The project claim is an ADDITIVE field on the SAME on-disk record file
    (`~/.hermes/decision_hud/actor_tokens/<hash>.json`), written by this
    module immediately after minting via the plugin's own
    `issue_actor_token()`. This is not a second store: it is the identical
    file, located via the plugin's own `_actor_token_path()` helper, with
    one extra key appended.

RESIDUAL RISK (flag explicitly, do not silently accept): `_validate_actor_token`
and `_actor_token_path` are underscore-prefixed, private-by-convention
members of another plugin's module, imported across a repo boundary via
`importlib` rather than a published API. If the decision-hud plugin
changes its on-disk record shape, hashing scheme, or renames/removes these
functions, this service can silently start rejecting all requests (or, in
the worst case, misreading the record) with no compile-time signal in this
repository. This coupling should be consolidated behind a small stable
public function (e.g. `issue_project_actor_token` /
`validate_project_actor_token`) exported from the decision-hud plugin
itself, rather than reached into from here, the next time that plugin is
touched by its owner.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Optional


class Unauthorized(Exception):
    """Missing or invalid actor token (maps to HTTP 401)."""


class Forbidden(Exception):
    """Valid token, but its project claim does not match the requested
    project scope (maps to HTTP 403)."""


_PLUGIN_DB_PATH_ENV = "DECISION_HUD_PLUGIN_DB_PATH"

_cached_module: Optional[ModuleType] = None


def _plugin_db_path() -> Path:
    override = os.environ.get(_PLUGIN_DB_PATH_ENV)
    if override:
        return Path(override)
    # Resolved lazily (not at import time) so tests that monkeypatch HOME to
    # an isolated directory before calling into this module see the real
    # plugin location, not a path frozen from whatever HOME was at import.
    return Path.home() / ".hermes" / "plugins" / "decision-hud" / "db.py"


def _load_plugin_db() -> ModuleType:
    """Import the real decision-hud plugin's db.py by file path (it is not
    an installed package), caching the module. Raises ImportError with a
    clear message if the sibling plugin is unavailable — this service must
    never fall back to a reinvented/weaker verifier silently."""
    global _cached_module
    if _cached_module is not None:
        return _cached_module
    path = _plugin_db_path()
    if not path.exists():
        raise ImportError(
            f"decision-hud plugin db module not found at {path}; set "
            f"{_PLUGIN_DB_PATH_ENV} or install the decision-hud plugin. "
            "Refusing to fall back to a reinvented verifier."
        )
    module_name = "decision_hud_plugin_db_reused"
    if module_name in sys.modules:
        _cached_module = sys.modules[module_name]
        return _cached_module
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load spec for decision-hud plugin db module at {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    _cached_module = module
    return module


def issue_project_actor_token(actor: str, project_id: str, *, ttl_seconds: Optional[int] = None) -> str:
    """Mint a token via the REAL plugin's issue_actor_token(), then append
    an explicit `project_id` claim to the identical on-disk record (located
    via the plugin's own `_actor_token_path()`). Returns the raw token —
    exactly like the underlying function, this is the only time it is
    available in plaintext."""
    if not project_id or not project_id.strip():
        raise ValueError("project_id is required to issue a project-scoped token")
    db = _load_plugin_db()
    kwargs = {} if ttl_seconds is None else {"ttl_seconds": ttl_seconds}
    raw = db.issue_actor_token(actor, **kwargs)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    path = db._actor_token_path(token_hash)  # reuse the plugin's own path helper
    record = json.loads(path.read_text())
    record["project_id"] = project_id.strip()
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    return raw


def authenticate_project_request(token: Optional[str], requested_project_id: str) -> str:
    """Validate `token` using the REAL plugin's `_validate_actor_token`
    (reused, not reinvented), then check the SAME record's `project_id`
    claim against `requested_project_id`.

    Raises Unauthorized (401) for missing/invalid/expired tokens, Forbidden
    (403) for a valid token whose project claim does not match the
    requested scope, or returns the actor identity string on success.
    """
    if not requested_project_id or not requested_project_id.strip():
        raise ValueError("requested_project_id is required")
    db = _load_plugin_db()
    actor = db._validate_actor_token(token)  # reused validity/expiry logic
    if actor is None or token is None:
        raise Unauthorized("missing or invalid actor token")
    token_hash = hashlib.sha256(token.strip().encode("utf-8")).hexdigest()
    path = db._actor_token_path(token_hash)
    try:
        record = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        # The token validated a moment ago but its record vanished/expired
        # between calls (e.g. cleanup raced us). Treat as invalid, not a
        # server error: the caller has no valid session either way.
        raise Unauthorized("actor token record is no longer readable")
    claimed_project = record.get("project_id")
    if not isinstance(claimed_project, str) or not claimed_project or claimed_project != requested_project_id.strip():
        raise Forbidden("actor token project claim does not match requested project scope")
    return actor
