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
from uuid import uuid4

DEFAULT_KANBAN_DB = str(Path.home() / ".hermes" / "kanban.db")

# Outcome -> display category, matching AGENT_METRICS_CATEGORY_LABELS in
# plugin.js (task_outcome_quality is the one category key that map already
# defines for exactly this kind of metric).
_OUTCOME_CATEGORY = "task_outcome_quality"


def _connect_readonly(path: str) -> sqlite3.Connection:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"kanban db not found: {path}")
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def build_checkpoints(*, kanban_db_path: str = DEFAULT_KANBAN_DB, scope: str) -> list[dict]:
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
        db_mtime = int(Path(kanban_db_path).stat().st_mtime)
    finally:
        conn.close()

    by_assignee: dict[str, dict] = {}
    for row in rows:
        assignee = row["assignee"] or row["profile"] or "unassigned"
        outcome = row["outcome"]
        bucket = by_assignee.setdefault(assignee, {})
        track = bucket.setdefault(outcome, {"volume": 0, "duration_total_s": 0.0, "duration_count": 0})
        track["volume"] += 1
        if row["ended_at"] is not None and row["started_at"] is not None:
            track["duration_total_s"] += max(0.0, row["ended_at"] - row["started_at"])
            track["duration_count"] += 1

    now = datetime.now(timezone.utc)
    occurred_at = now.isoformat().replace("+00:00", "Z")

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
        idempotency_key = hashlib.sha256(f"{scope}:{assignee}:{db_mtime}".encode()).hexdigest()
        checkpoints.append({
            "schema_version": "telemetry.v1",
            "event_id": str(uuid4()),
            "producer": "kanban-sync",
            "producer_instance_id": "sync_kanban_telemetry",
            "occurred_at": occurred_at,
            "received_at": occurred_at,
            "agent_id": assignee,
            "run_id": str(uuid4()),
            "task_id": str(uuid4()),
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


async def sync(*, kanban_db_path: str = DEFAULT_KANBAN_DB, scope: str, repository) -> int:
    """Build checkpoints from the Kanban DB and write each via the repository.

    Returns the number of checkpoints attempted (written or already-replayed
    via idempotency — both are success, per write_checkpoint's contract).
    """
    checkpoints = build_checkpoints(kanban_db_path=kanban_db_path, scope=scope)
    for payload in checkpoints:
        await repository.write_checkpoint(payload)
    return len(checkpoints)


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Sync real Kanban agent telemetry into the Postgres dashboard read model.")
    parser.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB)
    parser.add_argument("--scope", required=True, help="decision-hud project_id to scope these checkpoints to")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DASHBOARD_DATABASE_URL", "postgresql://dashboard:dashboard@127.0.0.1:55432/dashboard"),
    )
    args = parser.parse_args(argv)

    # Late import: keeps build_checkpoints() importable/testable without a
    # psycopg install for the pure-function unit tests above.
    from agent_dashboard.db.postgres import PostgresMetricsRepository

    async def _run():
        repository = PostgresMetricsRepository(args.database_url)
        await repository.open()
        try:
            await repository.migrate()
            written = await sync(kanban_db_path=args.kanban_db, scope=args.scope, repository=repository)
            print(f"synced {written} agent checkpoint(s) into scope={args.scope!r}")
        finally:
            await repository.close()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
