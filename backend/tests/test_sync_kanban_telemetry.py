"""RED-first tests for the Kanban -> Postgres telemetry.v1 sync bridge.

The Postgres-backed dashboard read model (agent_dashboard.db.postgres,
agent_dashboard.dashboard.read_model) is real, tested infrastructure — but
nothing writes real telemetry.v1 checkpoints into it; the only rows in the
live DB are hand-inserted test fixtures (scope='project:test-selected').
This script is the missing producer: it reads the SAME real Kanban
task_runs/tasks data that scripts/agent_metrics_snapshot.py already reads
(read-only, never mutates the Kanban DB), converts each real assignee's
outcome counters into a telemetry.v1 MetricSnapshot, and writes it as a
checkpoint via PostgresMetricsRepository.write_checkpoint() — the same
public write path backend/tests/test_read_only_vertical_slice.py already
exercises.

One checkpoint row per (scope, assignee) per sync run: the read model's
status() keeps only the latest row per agent_id and reads that row's WHOLE
values dict, so every outcome-track metric for that assignee must live on
ONE snapshot, not be split across several rows that would only let the
latest track survive.
"""
from __future__ import annotations

import importlib
import os
import sqlite3
import time
from pathlib import Path

import pytest


def _module():
    try:
        return importlib.import_module("scripts.sync_kanban_telemetry")
    except ModuleNotFoundError as exc:
        pytest.fail(f"scripts/sync_kanban_telemetry.py is absent: {exc}")


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
        CREATE TABLE task_links (
            parent_id TEXT NOT NULL, child_id TEXT NOT NULL
        );
        """
    )
    now = int(time.time())
    conn.execute("INSERT INTO tasks VALUES ('t1', 'Task 1', 'builder', 'done', NULL, ?)", (now,))
    conn.execute("INSERT INTO tasks VALUES ('t2', 'Task 2', 'builder', 'done', NULL, ?)", (now,))
    conn.execute("INSERT INTO tasks VALUES ('t3', 'Task 3', 'reviewer', 'blocked', NULL, ?)", (now,))
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t1', 'builder', 'done', 'completed', ?, ?)", (now - 100, now - 50),
    )
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t2', 'builder', 'crashed', 'crashed', ?, ?)", (now - 200, now - 150),
    )
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t3', 'reviewer', 'blocked', 'blocked', ?, NULL)", (now - 300,),
    )
    conn.commit()
    conn.close()


def test_build_checkpoints_groups_all_outcomes_per_assignee_into_one_snapshot(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)

    checkpoints = mod.build_checkpoints(kanban_db_path=str(db_path), scope="p_test123")

    assert isinstance(checkpoints, list)
    by_agent = {c["agent_id"]: c for c in checkpoints}
    assert set(by_agent) == {"builder", "reviewer"}

    builder = by_agent["builder"]
    assert builder["schema_version"] == "telemetry.v1"
    assert builder["scope"] == "p_test123"
    assert builder["provenance"] == "kanban-sync"
    # both of builder's outcome tracks must be on the SAME snapshot —
    # the read model keeps only the latest row per agent_id.
    assert "completed_volume" in builder["values"]
    assert "crashed_volume" in builder["values"]
    assert builder["values"]["completed_volume"]["raw_value"] == 1
    assert builder["values"]["crashed_volume"]["raw_value"] == 1
    assert builder["values"]["completed_volume"]["category"] == "task_outcome_quality"

    reviewer = by_agent["reviewer"]
    assert reviewer["values"]["blocked_volume"]["raw_value"] == 1
    # ended_at is NULL for the blocked run -> no duration metric fabricated
    assert "blocked_avg_duration_s" not in reviewer["values"]

    # every payload must be independently valid per contracts.MetricSnapshot
    contracts = importlib.import_module("agent_dashboard.domain.contracts")
    for payload in checkpoints:
        contracts.MetricSnapshot.from_dict(payload)


def test_build_checkpoints_is_read_only_never_writes_kanban_db(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)
    before = db_path.read_bytes()

    mod.build_checkpoints(kanban_db_path=str(db_path), scope="p_test123")

    assert db_path.read_bytes() == before


def test_build_checkpoints_empty_db_yields_no_checkpoints(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, session_id TEXT, created_at INTEGER);
        CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL, outcome TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
        CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL);
        """
    )
    conn.commit()
    conn.close()

    checkpoints = mod.build_checkpoints(kanban_db_path=str(db_path), scope="p_test123")
    assert checkpoints == []


@pytest.fixture
def postgres_url():
    value = os.environ.get("DASHBOARD_TEST_DATABASE_URL")
    if not value:
        pytest.skip("DASHBOARD_TEST_DATABASE_URL not set — integration part skipped")
    return value


@pytest.mark.asyncio
async def test_sync_writes_checkpoints_readable_via_public_repository_api(tmp_path, postgres_url):
    mod = _module()
    postgres = importlib.import_module("agent_dashboard.db.postgres")
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)
    scope = f"p_synctest_{int(time.time())}"

    repository = postgres.PostgresMetricsRepository(postgres_url)
    await repository.open()
    try:
        await repository.migrate()
        written = await mod.sync(kanban_db_path=str(db_path), scope=scope, repository=repository)
        assert written == 2  # builder + reviewer

        agent_ids = await repository.list_scope_agent_ids(scope=scope)
        assert set(agent_ids) == {"builder", "reviewer"}

        rows = await repository.query_recent_metrics(scope=scope, agent_ids=["builder"], limit=10)
        assert len(rows) == 1
        assert "completed_volume" in rows[0].values
        assert "crashed_volume" in rows[0].values
    finally:
        await repository.close()
