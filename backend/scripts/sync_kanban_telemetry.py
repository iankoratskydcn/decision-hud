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
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import NAMESPACE_URL, uuid5

DEFAULT_KANBAN_DB = str(Path.home() / ".hermes" / "kanban.db")
DEFAULT_STATE_DB = str(Path.home() / ".hermes" / "state.db")

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


def build_checkpoints(
    *, kanban_db_path: str = DEFAULT_KANBAN_DB, state_db_path: Optional[str] = DEFAULT_STATE_DB, scope: str,
) -> list[dict]:
    """Return a list of telemetry.v1 MetricSnapshot payload dicts, one per assignee."""
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
        idempotency_key = hashlib.sha256(f"{scope}:{assignee}:{db_mtime}".encode()).hexdigest()
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
    parser.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB)
    parser.add_argument("--state-db", default=DEFAULT_STATE_DB, help="Hermes state.db (token/cost/latency source)")
    parser.add_argument("--scope", required=True, help="decision-hud project_id to scope these checkpoints to")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DASHBOARD_DATABASE_URL", "postgresql://dashboard:dashboard@127.0.0.1:55432/dashboard"),
    )
    args = parser.parse_args(argv)

    # Late import: keeps build_checkpoints() importable/testable without a
    # psycopg install for the pure-function unit tests above.
    from agent_telemetry.db.postgres import PostgresMetricsRepository

    async def _run():
        repository = PostgresMetricsRepository(args.database_url)
        await repository.open()
        try:
            await repository.migrate()
            written = await sync(
                kanban_db_path=args.kanban_db, state_db_path=args.state_db, scope=args.scope, repository=repository,
            )
            print(f"synced {written} agent checkpoint(s) into scope={args.scope!r}")
        finally:
            await repository.close()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
