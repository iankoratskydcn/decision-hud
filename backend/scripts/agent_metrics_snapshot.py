"""Read-only adapter: Kanban SQLite -> Agent Metrics snapshot JSON.

Feeds the Agent Metrics widgets ported into plugin.js (heatmap, scatter,
parallel coordinates, treemap, radar, sankey handoff-flow). Talks to the
Kanban board DB and, best-effort, the Hermes session state.db for real
per-session USD cost — it never estimates or fabricates a cost number.
Invoked by the desktop pane the same way `hermes decision ...` is: as a
plain CLI subprocess via cli.exec, printing one JSON document to stdout.

Grain: one record per (assignee, outcome) pair, aggregated across every
task_runs row for that pair. `assignee` stands in for "model" per the
owner's Sep-2026 decision (Kanban has no separate model column — the
assignee profile IS the model choice in practice). `outcome` is task_runs
outcome verbatim (completed | blocked | crashed | timed_out | spawn_failed |
gave_up | reclaimed), not a stand-in "quality tier".
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path
from typing import Optional

SCHEMA_VERSION = "agent-metrics-snapshot.v1"

DEFAULT_KANBAN_DB = str(Path.home() / ".hermes" / "kanban.db")
DEFAULT_STATE_DB = str(Path.home() / ".hermes" / "state.db")


def _connect_readonly(path: str) -> sqlite3.Connection:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"kanban db not found: {path}")
    # uri mode + mode=ro: never risk writing to a live board DB from a
    # read-only metrics adapter, even if a future bug tried to.
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _load_session_costs(state_db_path: Optional[str]) -> dict:
    """session_id -> best-known cost in USD (actual, falling back to estimated).

    Returns {} (never partial/fabricated rows) when state_db_path is None
    or the file/table is missing — callers must treat that as "unavailable",
    not zero.
    """
    if not state_db_path or not Path(state_db_path).exists():
        return {}
    try:
        conn = sqlite3.connect(f"file:{state_db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT session_id, SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) AS cost "
            "FROM session_model_usage GROUP BY session_id"
        ).fetchall()
        conn.close()
        return {r["session_id"]: float(r["cost"] or 0.0) for r in rows}
    except sqlite3.DatabaseError:
        return {}


def build_snapshot(kanban_db_path: str = DEFAULT_KANBAN_DB, state_db_path: Optional[str] = DEFAULT_STATE_DB) -> dict:
    conn = _connect_readonly(kanban_db_path)
    try:
        run_rows = conn.execute(
            """
            SELECT tr.task_id, tr.profile, tr.outcome, tr.started_at, tr.ended_at,
                   t.assignee, t.session_id
            FROM task_runs tr
            JOIN tasks t ON t.id = tr.task_id
            WHERE tr.outcome IS NOT NULL
            """
        ).fetchall()

        link_rows = conn.execute(
            """
            SELECT tp.assignee AS parent_assignee, tc.assignee AS child_assignee
            FROM task_links tl
            JOIN tasks tp ON tp.id = tl.parent_id
            JOIN tasks tc ON tc.id = tl.child_id
            """
        ).fetchall()
    finally:
        conn.close()

    session_costs = _load_session_costs(state_db_path)

    buckets: dict[tuple, dict] = {}
    for row in run_rows:
        assignee = row["assignee"] or row["profile"] or "unassigned"
        outcome = row["outcome"]
        key = (assignee, outcome)
        bucket = buckets.setdefault(key, {
            "assignee": assignee, "outcome": outcome,
            "volume": 0, "duration_total_s": 0.0, "duration_count": 0,
            "cost_total_usd": 0.0, "cost_known": 0, "session_count": 0,
        })
        bucket["volume"] += 1
        if row["ended_at"] is not None and row["started_at"] is not None:
            bucket["duration_total_s"] += max(0.0, row["ended_at"] - row["started_at"])
            bucket["duration_count"] += 1
        session_id = row["session_id"]
        if session_id:
            bucket["session_count"] += 1
            if session_id in session_costs:
                bucket["cost_total_usd"] += session_costs[session_id]
                bucket["cost_known"] += 1

    records = []
    for bucket in buckets.values():
        avg_duration = (bucket["duration_total_s"] / bucket["duration_count"]) if bucket["duration_count"] else 0.0
        if bucket["cost_known"] == 0:
            cost_status, cost_usd = "unavailable", None
        elif bucket["cost_known"] < bucket["volume"]:
            cost_status, cost_usd = "partial", bucket["cost_total_usd"]
        else:
            cost_status, cost_usd = "complete", bucket["cost_total_usd"]
        records.append({
            "assignee": bucket["assignee"],
            "outcome": bucket["outcome"],
            "volume": bucket["volume"],
            "avg_duration_s": avg_duration,
            "cost_status": cost_status,
            "cost_usd": cost_usd,
        })

    handoff_counts: dict[tuple, int] = {}
    for row in link_rows:
        parent, child = row["parent_assignee"] or "unassigned", row["child_assignee"] or "unassigned"
        if parent == child:
            continue  # not a handoff — same profile picked up its own follow-up
        handoff_counts[(parent, child)] = handoff_counts.get((parent, child), 0) + 1
    handoffs = [{"from": f, "to": t, "volume": v} for (f, t), v in handoff_counts.items()]

    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": int(time.time()),
        "source": {"kanban_db": kanban_db_path, "state_db": state_db_path if session_costs else None},
        "records": records,
        "handoffs": handoffs,
    }


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Emit an Agent Metrics snapshot JSON from a Kanban DB.")
    parser.add_argument("--kanban-db", default=DEFAULT_KANBAN_DB)
    parser.add_argument("--state-db", default=DEFAULT_STATE_DB)
    args = parser.parse_args(argv)
    state_db = args.state_db if Path(args.state_db).exists() else None
    snapshot = build_snapshot(kanban_db_path=args.kanban_db, state_db_path=state_db)
    print(json.dumps(snapshot))


if __name__ == "__main__":
    main()
