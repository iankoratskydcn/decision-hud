"""Kanban -> Postgres telemetry.v1 sync bridge.

Reads real per-assignee outcome counters from a Kanban SQLite DB (same
read-only query shape as agent_metrics_snapshot.py — tasks JOIN task_runs,
never mutates the Kanban DB) and converts them into telemetry.v1
MetricSnapshot checkpoints, written via PostgresMetricsRepository's public
write_checkpoint() API (the same path backend/tests/
test_read_only_vertical_slice.py already exercises for the read model).

One checkpoint per (scope, assignee): DashboardReadModel.status() keeps
only the LATEST row per agent_id and reads that row's whole `values` dict,
so every outcome track for one assignee (completed_volume, blocked_volume,
crashed_volume, ...) must live on the same snapshot — never split across
several rows a later sync would silently shadow.

idempotency_key is scope+assignee+source-db-mtime, so re-running this sync
against unchanged Kanban data is a no-op (write_checkpoint's ON CONFLICT DO
NOTHING path), and a Kanban DB write in between produces a new key -> a
fresh row, never an ambiguous update-in-place of historical telemetry.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import NAMESPACE_URL, uuid5

DEFAULT_KANBAN_DB = str(Path.home() / ".hermes" / "kanban.db")
DEFAULT_STATE_DB = str(Path.home() / ".hermes" / "state.db")
DEFAULT_KANBAN_HOME = str(Path.home() / ".hermes")
DEFAULT_PROJECTS_DB = str(Path.home() / ".hermes" / "projects.db")

# Outcome -> display category, matching AGENT_METRICS_CATEGORY_LABELS in
# plugin.js (task_outcome_quality is the one category key that map already
# defines for exactly this kind of metric).
_OUTCOME_CATEGORY = "task_outcome_quality"
_COST_LATENCY_CATEGORY = "model_cost_latency"


def _connect_readonly(path: str) -> sqlite3.Connection:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"kanban db not found: {path}")
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _session_usage_by_task(conn: sqlite3.Connection, state_db_path: Optional[str]) -> dict[str, sqlite3.Row]:
    """``{task_id: sessions row}`` via ``tasks.session_id`` -> ``state.db``'s ``sessions.id``.

    Best-effort: a missing/unreadable state.db (or a task with no session_id,
    or a session_id no longer present in state.db) just means that task's
    token/cost/latency values are omitted — outcome-volume metrics never
    depend on this join succeeding.
    """
    if not state_db_path or not Path(state_db_path).exists():
        return {}
    conn.execute("ATTACH DATABASE ? AS st", (state_db_path,))
    try:
        rows = conn.execute(
            """
            SELECT t.id AS task_id, s.input_tokens, s.output_tokens,
                   s.estimated_cost_usd, s.actual_cost_usd, s.api_call_count
            FROM tasks t
            JOIN st.sessions s ON s.id = t.session_id
            WHERE t.session_id IS NOT NULL
            """
        ).fetchall()
        return {row["task_id"]: row for row in rows}
    finally:
        conn.execute("DETACH DATABASE st")


def payload_fingerprint(*parts) -> str:
    """Stable short hash of everything an idempotency_key must vary with.

    Content-addressed, not proxy-based (file mtimes, day buckets, ...): the
    fingerprint is derived from the ACTUAL payload content passed in, so it
    is structurally immune to the class of bug where a key is computed from
    a signal (one file's mtime, a date string) that doesn't cover every
    input the payload actually depends on — that exact gap crashed the
    "decision-hud telemetry checkpoint sync (all boards)" cron job on most
    of its ticks (idempotency_key hashed only kanban.db's mtime while the
    payload also depended on state.db's independent contents) before this
    fix. json.dumps(sort_keys=True) makes key order irrelevant; [:16] keeps
    idempotency_key (itself sha256'd afterward with scope/assignee) short.
    """
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def build_checkpoints(
    *, kanban_db_path: str = DEFAULT_KANBAN_DB, state_db_path: Optional[str] = DEFAULT_STATE_DB, scope: str,
) -> list[dict]:
    """Return a list of telemetry.v1 MetricSnapshot payload dicts, one per assignee.

    No project_id filtering: isolation is the CALLER's job — pass the ONE
    board's own kanban.db (see discover_board_dbs/DEFAULT_KANBAN_DB), never a
    shared multi-board file. Hermes kanban boards are already isolated at the
    filesystem level (one sqlite file per board; `default` lives at
    <home>/kanban.db, every other board at <home>/kanban/boards/<slug>/kanban.db)
    — a project_id column filter would be solving an isolation problem this
    layout doesn't have.
    """
    if not isinstance(scope, str) or not scope:
        raise ValueError("scope is required")

    conn = _connect_readonly(kanban_db_path)
    try:
        rows = conn.execute(
            """
            SELECT tr.task_id, tr.profile, tr.outcome, tr.started_at, tr.ended_at,
                   t.assignee
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            WHERE tr.outcome IS NOT NULL
            """
        ).fetchall()
        usage_by_task = _session_usage_by_task(conn, state_db_path)
        db_mtime = int(Path(kanban_db_path).stat().st_mtime)
    finally:
        conn.close()

    by_assignee: dict[str, dict] = {}
    usage_by_assignee: dict[str, dict] = {}
    for row in rows:
        assignee = row["assignee"] or row["profile"] or "unassigned"
        outcome = row["outcome"]
        bucket = by_assignee.setdefault(assignee, {})
        track = bucket.setdefault(outcome, {"volume": 0, "duration_total_s": 0.0, "duration_count": 0})
        track["volume"] += 1
        if row["ended_at"] is not None and row["started_at"] is not None:
            track["duration_total_s"] += max(0.0, row["ended_at"] - row["started_at"])
            track["duration_count"] += 1

        usage = usage_by_task.get(row["task_id"])
        if usage is not None:
            agg = usage_by_assignee.setdefault(assignee, {
                "input_tokens": 0, "output_tokens": 0, "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0, "api_call_count": 0,
            })
            agg["input_tokens"] += usage["input_tokens"] or 0
            agg["output_tokens"] += usage["output_tokens"] or 0
            agg["estimated_cost_usd"] += usage["estimated_cost_usd"] or 0.0
            agg["actual_cost_usd"] += usage["actual_cost_usd"] or 0.0
            agg["api_call_count"] += usage["api_call_count"] or 0

    # Deterministic per-sync timestamp: derived from the Kanban DB's own
    # mtime, not wall-clock now(). Two syncs of the SAME unchanged Kanban
    # data must produce byte-identical payloads (occurred_at included) or
    # write_checkpoint's idempotency replay path sees a false conflict
    # (same idempotency_key, different payload) instead of a true no-op.
    occurred_at = datetime.fromtimestamp(db_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    checkpoints = []
    for assignee, outcomes in sorted(by_assignee.items()):
        values: dict[str, dict] = {}
        for outcome, track in sorted(outcomes.items()):
            values[f"{outcome}_volume"] = {
                "raw_value": track["volume"],
                "value_type": "number",
                "unit": "count",
                "category": _OUTCOME_CATEGORY,
            }
            if track["duration_count"] > 0:
                values[f"{outcome}_avg_duration_s"] = {
                    "raw_value": track["duration_total_s"] / track["duration_count"],
                    "value_type": "number",
                    "unit": "seconds",
                    "category": _OUTCOME_CATEGORY,
                }
        usage = usage_by_assignee.get(assignee)
        if usage is not None:
            values["input_tokens"] = {
                "raw_value": usage["input_tokens"], "value_type": "number", "unit": "count",
                "category": _COST_LATENCY_CATEGORY,
            }
            values["output_tokens"] = {
                "raw_value": usage["output_tokens"], "value_type": "number", "unit": "count",
                "category": _COST_LATENCY_CATEGORY,
            }
            values["estimated_cost_usd"] = {
                "raw_value": usage["estimated_cost_usd"], "value_type": "number", "unit": "usd",
                "category": _COST_LATENCY_CATEGORY,
            }
            values["actual_cost_usd"] = {
                "raw_value": usage["actual_cost_usd"], "value_type": "number", "unit": "usd",
                "category": _COST_LATENCY_CATEGORY,
            }
            values["api_call_count"] = {
                "raw_value": usage["api_call_count"], "value_type": "number", "unit": "count",
                "category": _COST_LATENCY_CATEGORY,
            }
        idempotency_key = hashlib.sha256(f"{scope}:{assignee}:{payload_fingerprint(values, occurred_at)}".encode()).hexdigest()
        # event_id/run_id/task_id are deterministic (uuid5 of idempotency_key),
        # not uuid4 random: a re-run against the SAME unchanged Kanban data must
        # produce the exact same payload for write_checkpoint's replay check to
        # see a true no-op instead of a spurious "idempotency key conflicts".
        deterministic_uuid = uuid5(NAMESPACE_URL, f"decision-hud-sync:{idempotency_key}")
        checkpoints.append({
            "schema_version": "telemetry.v1",
            "event_id": str(deterministic_uuid),
            "producer": "kanban-sync",
            "producer_instance_id": "sync_kanban_telemetry",
            "occurred_at": occurred_at,
            "received_at": occurred_at,
            "agent_id": assignee,
            "run_id": str(deterministic_uuid),
            "task_id": str(deterministic_uuid),
            "task_type": "kanban-rollup",
            "scope": scope,
            "provenance": "kanban-sync",
            "idempotency_key": idempotency_key,
            "source": "checkpoint",
            "authoritative": True,
            "completeness": "partial",
            "captured_at": occurred_at,
            "values": values,
            "quality_flags": [],
        })
    return checkpoints


def discover_board_dbs(kanban_home: str) -> list[tuple[str, str]]:
    """``[(board_slug, kanban_db_path), ...]`` for every board that actually
    has a kanban.db on disk: ``default`` lives at ``<home>/kanban.db`` (an
    exception baked into hermes_cli/kanban_db.py's boards_root()), every
    other board at ``<home>/kanban/boards/<slug>/kanban.db``.
    """
    home = Path(kanban_home)
    found: list[tuple[str, str]] = []
    default_db = home / "kanban.db"
    if default_db.exists():
        found.append(("default", str(default_db)))
    boards_root = home / "kanban" / "boards"
    if boards_root.is_dir():
        for board_dir in sorted(boards_root.iterdir()):
            if board_dir.name.startswith("_"):  # e.g. _archived
                continue
            db_path = board_dir / "kanban.db"
            if db_path.exists() and db_path.stat().st_size > 0:
                found.append((board_dir.name, str(db_path)))
    return found


def resolve_project_ids_by_board(projects_db_path: str) -> dict[str, str]:
    """``{board_slug: project_id}`` for every non-archived project that has a
    board_slug, read from Hermes's projects.db (same one decision-hud's own
    project picker reads). A board with no matching project is skipped by
    the caller, not defaulted to some made-up scope.
    """
    if not Path(projects_db_path).exists():
        return {}
    conn = sqlite3.connect(f"file:{projects_db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, board_slug FROM projects WHERE board_slug IS NOT NULL AND archived = 0"
        ).fetchall()
        return {row["board_slug"]: row["id"] for row in rows}
    finally:
        conn.close()


async def sync(
    *, kanban_db_path: str = DEFAULT_KANBAN_DB, state_db_path: Optional[str] = DEFAULT_STATE_DB,
    scope: str, repository,
) -> int:
    """Build checkpoints from the Kanban DB and write each via the repository.

    Returns the number of checkpoints attempted (written or already-replayed
    via idempotency — both are success, per write_checkpoint's contract).
    """
    checkpoints = build_checkpoints(kanban_db_path=kanban_db_path, state_db_path=state_db_path, scope=scope)
    for payload in checkpoints:
        await repository.write_checkpoint(payload)
    return len(checkpoints)


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Sync real Kanban agent telemetry into the Postgres dashboard read model.")
    parser.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB, help="single-board mode: path to that board's kanban.db")
    parser.add_argument("--state-db", default=DEFAULT_STATE_DB, help="Hermes state.db (token/cost/latency source)")
    parser.add_argument("--scope", help="decision-hud project_id to scope these checkpoints to (single-board mode)")
    parser.add_argument(
        "--all-boards", action="store_true",
        help="sync every Hermes kanban board that maps to a decision-hud project, each from its OWN kanban.db",
    )
    parser.add_argument("--kanban-home", default=DEFAULT_KANBAN_HOME, help="--all-boards: Hermes home (parent of kanban.db / kanban/boards/)")
    parser.add_argument("--projects-db", default=DEFAULT_PROJECTS_DB, help="--all-boards: projects.db mapping board_slug -> project_id")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DASHBOARD_DATABASE_URL", "postgresql://dashboard:dashboard@127.0.0.1:55432/dashboard"),
    )
    args = parser.parse_args(argv)
    if bool(args.scope) == bool(args.all_boards):
        parser.error("pass exactly one of --scope or --all-boards")

    # Late import: keeps build_checkpoints() importable/testable without a
    # psycopg install for the pure-function unit tests above.
    from agent_telemetry.db.postgres import PostgresMetricsRepository

    async def _run():
        repository = PostgresMetricsRepository(args.database_url)
        await repository.open()
        try:
            await repository.migrate()
            if args.all_boards:
                project_id_by_board = resolve_project_ids_by_board(args.projects_db)
                for slug, db_path in discover_board_dbs(args.kanban_home):
                    scope = project_id_by_board.get(slug)
                    if not scope:
                        print(f"skipped board={slug!r}: no matching decision-hud project (board_slug not found in projects.db)")
                        continue
                    try:
                        written = await sync(
                            kanban_db_path=db_path, state_db_path=args.state_db, scope=scope, repository=repository,
                        )
                    except sqlite3.OperationalError as exc:
                        # ponytail: skip, don't crash the whole run — a board
                        # DB predating the task_runs schema has nothing to
                        # sync yet, that's not an error in the other boards.
                        print(f"skipped board={slug!r} scope={scope!r}: {exc}")
                        continue
                    print(f"synced {written} agent checkpoint(s) from board={slug!r} into scope={scope!r}")
            else:
                written = await sync(
                    kanban_db_path=args.kanban_db, state_db_path=args.state_db, scope=args.scope, repository=repository,
                )
                print(f"synced {written} agent checkpoint(s) into scope={args.scope!r}")
        finally:
            await repository.close()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
