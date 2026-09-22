"""RED-first tests for the Kanban -> Postgres telemetry.v1 sync bridge.

The Postgres-backed dashboard read model (agent_telemetry.db.postgres,
agent_telemetry.dashboard.read_model) is real, tested infrastructure — but
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


def _make_kanban_db(path: Path, *, with_sessions: bool = False, project_id: str = "p_test123") -> None:
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT,
            session_id TEXT, created_at INTEGER, project_id TEXT
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
    t1_session = "sess-t1" if with_sessions else None
    t2_session = "sess-t2" if with_sessions else None
    conn.execute("INSERT INTO tasks VALUES ('t1', 'Task 1', 'builder', 'done', ?, ?, ?)", (t1_session, now, project_id))
    conn.execute("INSERT INTO tasks VALUES ('t2', 'Task 2', 'builder', 'done', ?, ?, ?)", (t2_session, now, project_id))
    conn.execute("INSERT INTO tasks VALUES ('t3', 'Task 3', 'reviewer', 'blocked', NULL, ?, ?)", (now, project_id))
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


def _make_state_db(path: Path) -> None:
    """A minimal state.db with just the sessions columns the sync reads."""
    conn = sqlite3.connect(str(path))
    conn.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
            estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER DEFAULT 0
        )
        """
    )
    conn.execute("INSERT INTO sessions VALUES ('sess-t1', 1000, 200, 0.05, 0.04, 3)")
    conn.execute("INSERT INTO sessions VALUES ('sess-t2', 500, 100, 0.02, NULL, 2)")
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
    contracts = importlib.import_module("agent_telemetry.domain.contracts")
    for payload in checkpoints:
        contracts.MetricSnapshot.from_dict(payload)


def test_build_checkpoints_joins_session_token_cost_latency_when_state_db_given(tmp_path):
    mod = _module()
    kanban_db_path = tmp_path / "kanban.db"
    state_db_path = tmp_path / "state.db"
    _make_kanban_db(kanban_db_path, with_sessions=True)
    _make_state_db(state_db_path)

    checkpoints = mod.build_checkpoints(
        kanban_db_path=str(kanban_db_path), state_db_path=str(state_db_path), scope="p_test123",
    )
    by_agent = {c["agent_id"]: c for c in checkpoints}
    builder = by_agent["builder"]

    # builder's two task_runs (t1 -> sess-t1, t2 -> sess-t2) roll up together.
    assert builder["values"]["input_tokens"]["raw_value"] == 1500
    assert builder["values"]["output_tokens"]["raw_value"] == 300
    assert builder["values"]["estimated_cost_usd"]["raw_value"] == pytest.approx(0.07)
    assert builder["values"]["actual_cost_usd"]["raw_value"] == pytest.approx(0.04)
    assert builder["values"]["api_call_count"]["raw_value"] == 5
    assert builder["values"]["input_tokens"]["category"] == "model_cost_latency"

    # reviewer's run has no session_id -> no model_cost_latency values fabricated.
    reviewer = by_agent["reviewer"]
    assert "input_tokens" not in reviewer["values"]


def test_build_checkpoints_without_state_db_skips_cost_latency_values(tmp_path):
    mod = _module()
    kanban_db_path = tmp_path / "kanban.db"
    _make_kanban_db(kanban_db_path, with_sessions=True)

    checkpoints = mod.build_checkpoints(kanban_db_path=str(kanban_db_path), state_db_path=None, scope="p_test123")
    by_agent = {c["agent_id"]: c for c in checkpoints}
    assert "input_tokens" not in by_agent["builder"]["values"]


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
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, session_id TEXT, created_at INTEGER, project_id TEXT);
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
    postgres = importlib.import_module("agent_telemetry.db.postgres")
    db_path = tmp_path / "kanban.db"
    scope = f"p_synctest_{int(time.time())}"
    _make_kanban_db(db_path, project_id=scope)

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


def test_build_checkpoints_ignores_project_id_isolation_is_by_file(tmp_path):
    """Isolation is per-board-file, not a project_id column filter — a task
    tagged with a different project_id still surfaces if it's in the DB the
    caller pointed at. discover_board_dbs/resolve_project_ids_by_board are
    what keep boards from leaking into each other, not this function."""
    mod = _module()
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path, project_id="p_alpha")
    conn = sqlite3.connect(str(db_path))
    conn.execute("INSERT INTO tasks VALUES ('t9', 'Other project task', 'other-agent', 'done', NULL, ?, 'p_beta')", (int(time.time()),))
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t9', 'other-agent', 'done', 'completed', ?, ?)", (int(time.time()) - 10, int(time.time())),
    )
    conn.commit()
    conn.close()

    checkpoints = mod.build_checkpoints(kanban_db_path=str(db_path), scope="p_alpha")

    assert {c["agent_id"] for c in checkpoints} == {"builder", "reviewer", "other-agent"}


def test_discover_board_dbs_finds_default_and_named_boards(tmp_path):
    home = tmp_path / "hermes_home"
    (home / "kanban" / "boards" / "alpha").mkdir(parents=True)
    (home / "kanban" / "boards" / "alpha" / "kanban.db").write_bytes(b"x")
    (home / "kanban" / "boards" / "_archived").mkdir(parents=True)
    (home / "kanban" / "boards" / "_archived" / "kanban.db").write_bytes(b"x")
    (home / "kanban" / "boards" / "empty").mkdir(parents=True)
    (home / "kanban" / "boards" / "empty" / "kanban.db").write_bytes(b"")  # 0 bytes: skip
    (home / "kanban.db").write_bytes(b"x")

    mod = _module()
    found = dict(mod.discover_board_dbs(str(home)))

    assert set(found) == {"default", "alpha"}
    assert found["default"] == str(home / "kanban.db")


def test_resolve_project_ids_by_board_reads_projects_db(tmp_path):
    projects_db = tmp_path / "projects.db"
    conn = sqlite3.connect(str(projects_db))
    conn.execute("CREATE TABLE projects (id TEXT, board_slug TEXT, archived INTEGER)")
    conn.execute("INSERT INTO projects VALUES ('p_1', 'decision-hud', 0)")
    conn.execute("INSERT INTO projects VALUES ('p_2', 'archived-board', 1)")
    conn.execute("INSERT INTO projects VALUES ('p_3', NULL, 0)")
    conn.commit()
    conn.close()

    mod = _module()
    result = mod.resolve_project_ids_by_board(str(projects_db))

    assert result == {"decision-hud": "p_1"}
