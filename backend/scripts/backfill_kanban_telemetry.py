"""One-shot backfill: seed Postgres telemetry.v1 history from Kanban's
``task_runs`` table, so day one of the dashboard isn't an empty chart.

Reuses sync_kanban_telemetry.py's read-only Kanban query shape and
write_checkpoint() path — the only difference is bucketing: instead of one
current-state checkpoint per assignee, this writes one checkpoint per
(day, assignee), each dated to that historical day (not "now"), for however
far back task_runs.outcome data goes.

Kanban-sync's own regular sync (sync_kanban_telemetry.py) and this backfill
share idempotency namespace by using disjoint idempotency_key prefixes
("kanban-backfill:" vs the live sync's undecorated key), so running both
against the same scope never collides.

The sidecar producer has no comparable backfill (events were never captured
pre-cutover) — this script only ever writes producer="kanban-sync" rows. The
earliest written checkpoint carries an extra "history_begins_at" value
(category="producer_history_meta") so a caller can tell where kanban-sync's
history actually starts without assuming symmetry with the sidecars
producer, which has no such marker and simply starts at Wave 0's cutover.
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

from scripts.sync_kanban_telemetry import (
    DEFAULT_KANBAN_DB,
    DEFAULT_STATE_DB,
    _OUTCOME_CATEGORY,
    _connect_readonly,
)

_HISTORY_META_CATEGORY = "producer_history_meta"


def _day_bucket(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


def _day_end_iso(day: str) -> str:
    return f"{day}T23:59:59Z"


def build_backfill_checkpoints(
    *, kanban_db_path: str = DEFAULT_KANBAN_DB, scope: str,
) -> list[dict]:
    """One telemetry.v1 checkpoint per (day, assignee), oldest day first.

    Only outcome-volume/duration metrics are backfilled — task_runs has no
    token/cost columns, and the sessions join sync_kanban_telemetry.py uses
    for those has no per-day granularity to bucket against, so backfilling
    it would fabricate a daily split that never existed. Live syncs pick up
    cost/latency going forward; this script only fills the outcome-volume
    gap for days before the cron existed.
    """
    if not isinstance(scope, str) or not scope:
        raise ValueError("scope is required")

    conn = _connect_readonly(kanban_db_path)
    try:
        rows = conn.execute(
            """
            SELECT tr.profile, tr.outcome, tr.started_at, tr.ended_at, t.assignee
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            WHERE tr.outcome IS NOT NULL
            """
        ).fetchall()
    finally:
        conn.close()

    # {day: {assignee: {outcome: {"volume": n, "duration_total_s": f, "duration_count": n}}}}
    by_day: dict[str, dict[str, dict]] = {}
    for row in rows:
        anchor = row["ended_at"] if row["ended_at"] is not None else row["started_at"]
        if anchor is None:
            continue
        day = _day_bucket(anchor)
        assignee = row["assignee"] or row["profile"] or "unassigned"
        outcome = row["outcome"]
        bucket = by_day.setdefault(day, {}).setdefault(assignee, {})
        track = bucket.setdefault(outcome, {"volume": 0, "duration_total_s": 0.0, "duration_count": 0})
        track["volume"] += 1
        if row["ended_at"] is not None and row["started_at"] is not None:
            track["duration_total_s"] += max(0.0, row["ended_at"] - row["started_at"])
            track["duration_count"] += 1

    checkpoints: list[dict] = []
    earliest_day = min(by_day, default=None)
    for day, by_assignee in sorted(by_day.items()):
        occurred_at = _day_end_iso(day)
        for assignee, outcomes in sorted(by_assignee.items()):
            values: dict[str, dict] = {}
            for outcome, track in sorted(outcomes.items()):
                values[f"{outcome}_volume"] = {
                    "raw_value": track["volume"], "value_type": "number", "unit": "count",
                    "category": _OUTCOME_CATEGORY,
                }
                if track["duration_count"] > 0:
                    values[f"{outcome}_avg_duration_s"] = {
                        "raw_value": track["duration_total_s"] / track["duration_count"],
                        "value_type": "number", "unit": "seconds", "category": _OUTCOME_CATEGORY,
                    }
            if day == earliest_day:
                values["history_begins_at"] = {
                    "raw_value": occurred_at, "value_type": "timestamp", "unit": "iso8601",
                    "category": _HISTORY_META_CATEGORY,
                }
            idempotency_key = hashlib.sha256(f"kanban-backfill:{scope}:{assignee}:{day}".encode()).hexdigest()
            deterministic_uuid = uuid5(NAMESPACE_URL, f"decision-hud-backfill:{idempotency_key}")
            checkpoints.append({
                "schema_version": "telemetry.v1",
                "event_id": str(deterministic_uuid),
                "producer": "kanban-sync",
                "producer_instance_id": "backfill_kanban_telemetry",
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


async def backfill(*, kanban_db_path: str = DEFAULT_KANBAN_DB, scope: str, repository) -> int:
    checkpoints = build_backfill_checkpoints(kanban_db_path=kanban_db_path, scope=scope)
    for payload in checkpoints:
        await repository.write_checkpoint(payload)
    return len(checkpoints)


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(
        description="One-shot backfill of Kanban task_runs history into the Postgres dashboard read model."
    )
    parser.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB)
    parser.add_argument("--scope", required=True, help="decision-hud project_id to scope these checkpoints to")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DASHBOARD_DATABASE_URL", "postgresql://dashboard:***@127.0.0.1:55432/dashboard"),
    )
    args = parser.parse_args(argv)

    from agent_telemetry.db.postgres import PostgresMetricsRepository

    async def _run():
        repository = PostgresMetricsRepository(args.database_url)
        await repository.open()
        try:
            await repository.migrate()
            written = await backfill(kanban_db_path=args.kanban_db, scope=args.scope, repository=repository)
            print(f"backfilled {written} historical checkpoint(s) into scope={args.scope!r}")
        finally:
            await repository.close()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
