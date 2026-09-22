"""Wave 1a: DashboardReadModel's second data path (live Agent Matrix SQLite).

Verifies the live-snapshot path is reachable off the same read model
without a second HTTP surface, and that its schema is always distinguishable
from the Postgres-backed status() path — the two must never be blended.
"""
from __future__ import annotations

import json
import sqlite3

from agent_telemetry.dashboard.read_model import DashboardReadModel, PLUGIN_SCHEMA_VERSION


def _make_kanban_db(path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE tasks (id TEXT PRIMARY KEY, assignee TEXT, session_id TEXT);
        CREATE TABLE task_runs (task_id TEXT, profile TEXT, outcome TEXT, started_at REAL, ended_at REAL);
        CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
        INSERT INTO tasks VALUES ('t1', 'default', NULL);
        INSERT INTO task_runs VALUES ('t1', 'default', 'completed', 0.0, 1.0);
        """
    )
    conn.commit()
    conn.close()


def test_live_snapshot_is_a_static_method_no_repository_needed():
    # No repository/HTTP dependency required for the live-local path — it
    # is a second, explicitly-labeled path off the same read model, not a
    # second HTTP surface.
    assert isinstance(DashboardReadModel.__dict__["live_snapshot"], staticmethod)


def test_live_snapshot_reads_kanban_sqlite_and_tags_schema_distinctly(tmp_path):
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)

    snapshot = DashboardReadModel.live_snapshot(kanban_db_path=str(kanban_db), state_db_path=str(tmp_path / "missing-state.db"))

    assert snapshot["schema_version"] == "agent-metrics-snapshot.v1"
    assert snapshot["schema_version"] != PLUGIN_SCHEMA_VERSION
    assert snapshot["records"] == [
        {
            "assignee": "default",
            "outcome": "completed",
            "volume": 1,
            "avg_duration_s": 1.0,
            "cost_status": "unavailable",
            "cost_usd": None,
        }
    ]
    # Round-trips through JSON same as the CLI path (no extra objects).
    json.dumps(snapshot)


def test_live_snapshot_missing_kanban_db_raises_not_silently_empty(tmp_path):
    import pytest

    with pytest.raises(FileNotFoundError):
        DashboardReadModel.live_snapshot(kanban_db_path=str(tmp_path / "nope.db"))
