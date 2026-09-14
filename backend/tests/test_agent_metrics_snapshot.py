"""RED-first tests for the read-only Kanban -> agent-metrics snapshot adapter.

This adapter is the sole data source for the Agent Metrics widgets ported
into plugin.js (heatmap/scatter/parcoord/treemap/radar/sankey). It reads
directly from a Kanban SQLite DB (tasks + task_runs + task_links) and,
best-effort, a Hermes state.db for real per-session USD cost — it never
fabricates numbers. No Postgres, no auth token: this mirrors how
`hermes decision ...` already talks to the pane via cli.exec.
"""

from __future__ import annotations

import importlib
import json
import sqlite3
import time
from pathlib import Path

import pytest


def _module():
    try:
        return importlib.import_module("scripts.agent_metrics_snapshot")
    except ModuleNotFoundError as exc:
        pytest.fail(f"scripts/agent_metrics_snapshot.py is absent: {exc}")


def _make_kanban_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT,
            session_id TEXT, created_at INTEGER
        );
        CREATE TABLE task_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
            profile TEXT, status TEXT NOT NULL, outcome TEXT,
            started_at INTEGER NOT NULL, ended_at INTEGER
        );
        CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL);
        """
    )
    now = int(time.time())
    rows = [
        ("t1", "task one", "builder", "done", "s1", now - 1000),
        ("t2", "task two", "builder", "done", None, now - 900),
        ("t3", "task three", "reviewer", "blocked", None, now - 800),
        ("t4", "task four", "reviewer", "done", None, now - 700),
    ]
    conn.executemany("INSERT INTO tasks VALUES (?,?,?,?,?,?)", rows)
    runs = [
        ("t1", "builder", "done", "completed", now - 1000, now - 940),
        ("t2", "builder", "done", "completed", now - 900, now - 820),
        ("t3", "reviewer", "blocked", "blocked", now - 800, now - 760),
        ("t4", "reviewer", "done", "completed", now - 700, now - 600),
    ]
    conn.executemany("INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES (?,?,?,?,?,?)", runs)
    conn.executemany("INSERT INTO task_links VALUES (?,?)", [("t1", "t3"), ("t3", "t4")])
    conn.commit()
    conn.close()


def _make_state_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE session_model_usage (
            session_id TEXT NOT NULL, model TEXT NOT NULL,
            estimated_cost_usd REAL NOT NULL DEFAULT 0,
            actual_cost_usd REAL NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("INSERT INTO sessions VALUES ('s1')")
    conn.execute(
        "INSERT INTO session_model_usage (session_id, model, estimated_cost_usd, actual_cost_usd) VALUES ('s1','claude-sonnet-5',0.42,0.5)"
    )
    conn.commit()
    conn.close()


def test_snapshot_has_required_top_level_shape(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=None)
    assert snapshot["schema_version"] == "agent-metrics-snapshot.v1"
    assert "updated_at" in snapshot
    assert isinstance(snapshot["records"], list)
    assert isinstance(snapshot["handoffs"], list)


def test_records_group_by_assignee_and_outcome(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=None)
    key = {(r["assignee"], r["outcome"]) for r in snapshot["records"]}
    assert ("builder", "completed") in key
    assert ("reviewer", "blocked") in key
    assert ("reviewer", "completed") in key


def test_record_carries_duration_and_volume():
    pass  # covered indirectly below


def test_record_duration_and_volume_from_fixture(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=None)
    builder_completed = next(r for r in snapshot["records"] if r["assignee"] == "builder" and r["outcome"] == "completed")
    assert builder_completed["volume"] == 2
    assert builder_completed["avg_duration_s"] > 0


def test_cost_is_joined_when_session_id_and_state_db_present(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    state_db = tmp_path / "state.db"
    _make_kanban_db(kanban_db)
    _make_state_db(state_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=str(state_db))
    builder_completed = next(r for r in snapshot["records"] if r["assignee"] == "builder" and r["outcome"] == "completed")
    # t1 has session_id=s1 with a real cost row; t2 has no session_id.
    assert builder_completed["cost_status"] == "partial"
    assert builder_completed["cost_usd"] is not None
    assert builder_completed["cost_usd"] >= 0.42


def test_cost_is_unavailable_never_fabricated_without_state_db(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=None)
    for record in snapshot["records"]:
        assert record["cost_status"] == "unavailable"
        assert record["cost_usd"] is None


def test_handoffs_derived_from_task_links_parent_child_assignee(tmp_path):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    snapshot = mod.build_snapshot(kanban_db_path=str(kanban_db), state_db_path=None)
    pairs = {(h["from"], h["to"]) for h in snapshot["handoffs"]}
    # t1(builder) -> t3(reviewer), t3(reviewer) -> t4(reviewer) is a self-loop, dropped
    assert ("builder", "reviewer") in pairs
    assert ("reviewer", "reviewer") not in pairs


def test_missing_kanban_db_raises_clear_error(tmp_path):
    mod = _module()
    missing = tmp_path / "nope.db"
    with pytest.raises(FileNotFoundError):
        mod.build_snapshot(kanban_db_path=str(missing), state_db_path=None)


def test_cli_main_prints_json(tmp_path, capsys):
    mod = _module()
    kanban_db = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db)
    mod.main(["--kanban-db", str(kanban_db)])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["schema_version"] == "agent-metrics-snapshot.v1"
