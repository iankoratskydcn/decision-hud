"""Tests for the Kanban task_runs -> Postgres history backfill script."""
from __future__ import annotations

import importlib
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def _module():
    try:
        return importlib.import_module("scripts.backfill_kanban_telemetry")
    except ModuleNotFoundError as exc:
        pytest.fail(f"scripts/backfill_kanban_telemetry.py is absent: {exc}")


def _make_kanban_db(path: Path) -> None:
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
        """
    )
    now = int(time.time())
    day_ago = now - 86400
    two_days_ago = now - 2 * 86400
    conn.execute("INSERT INTO tasks VALUES ('t1', 'Task 1', 'builder', 'done', NULL, ?, 'p_test123')", (now,))
    conn.execute("INSERT INTO tasks VALUES ('t2', 'Task 2', 'builder', 'done', NULL, ?, 'p_test123')", (now,))
    conn.execute("INSERT INTO tasks VALUES ('t3', 'Task 3', 'reviewer', 'blocked', NULL, ?, 'p_test123')", (now,))
    # Oldest run (two days ago) -> builder completed.
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t1', 'builder', 'done', 'completed', ?, ?)", (two_days_ago - 100, two_days_ago - 50),
    )
    # Yesterday -> builder crashed.
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t2', 'builder', 'crashed', 'crashed', ?, ?)", (day_ago - 200, day_ago - 150),
    )
    # Yesterday -> reviewer blocked, no ended_at (in-flight-looking row).
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) VALUES "
        "('t3', 'reviewer', 'blocked', 'blocked', ?, NULL)", (day_ago - 300,),
    )
    conn.commit()
    conn.close()


def test_build_backfill_checkpoints_buckets_by_day_and_assignee(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)

    checkpoints = mod.build_backfill_checkpoints(kanban_db_path=str(db_path), scope="p_test123")

    # 2 distinct days x up to 2 assignees per day -> 3 checkpoints
    # (day 1: builder only; day 2: builder + reviewer).
    assert len(checkpoints) == 3
    for payload in checkpoints:
        assert payload["schema_version"] == "telemetry.v1"
        assert payload["producer"] == "kanban-sync"
        assert payload["scope"] == "p_test123"

    days = sorted({c["occurred_at"][:10] for c in checkpoints})
    assert len(days) == 2
    assert days == sorted(days)  # oldest first is implied by sort order below

    oldest_day_checkpoints = [c for c in checkpoints if c["occurred_at"][:10] == days[0]]
    assert len(oldest_day_checkpoints) == 1
    oldest = oldest_day_checkpoints[0]
    assert oldest["agent_id"] == "builder"
    assert oldest["values"]["completed_volume"]["raw_value"] == 1
    # earliest checkpoint overall carries the history-begins marker
    assert "history_begins_at" in oldest["values"]
    assert oldest["values"]["history_begins_at"]["category"] == "producer_history_meta"

    newer_day_checkpoints = {c["agent_id"]: c for c in checkpoints if c["occurred_at"][:10] == days[1]}
    assert set(newer_day_checkpoints) == {"builder", "reviewer"}
    assert newer_day_checkpoints["builder"]["values"]["crashed_volume"]["raw_value"] == 1
    assert "history_begins_at" not in newer_day_checkpoints["builder"]["values"]
    # blocked run has no ended_at -> no duration fabricated
    assert "blocked_avg_duration_s" not in newer_day_checkpoints["reviewer"]["values"]


def test_build_backfill_checkpoints_never_writes_kanban_db(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)
    before = db_path.read_bytes()

    mod.build_backfill_checkpoints(kanban_db_path=str(db_path), scope="p_test123")

    assert db_path.read_bytes() == before


def test_build_backfill_checkpoints_empty_db_yields_nothing(tmp_path):
    mod = _module()
    db_path = tmp_path / "kanban.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, session_id TEXT, created_at INTEGER);
        CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL, outcome TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
        """
    )
    conn.commit()
    conn.close()

    assert mod.build_backfill_checkpoints(kanban_db_path=str(db_path), scope="p_test123") == []


def test_backfill_idempotency_key_disjoint_from_live_sync(tmp_path):
    """A backfill checkpoint and a live-sync checkpoint for the same
    (scope, assignee) must never collide on idempotency_key — the live sync
    covers "current state", the backfill covers historical days; both must
    be free to coexist as distinct rows."""
    mod = _module()
    live = importlib.import_module("scripts.sync_kanban_telemetry")
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)

    backfill_keys = {c["idempotency_key"] for c in mod.build_backfill_checkpoints(kanban_db_path=str(db_path), scope="p_test123")}
    live_keys = {c["idempotency_key"] for c in live.build_checkpoints(kanban_db_path=str(db_path), scope="p_test123")}

    assert backfill_keys.isdisjoint(live_keys)


@pytest.fixture
def postgres_url():
    value = os.environ.get("DASHBOARD_TEST_DATABASE_URL")
    if not value:
        pytest.skip("DASHBOARD_TEST_DATABASE_URL not set — integration part skipped")
    return value


@pytest.mark.asyncio
async def test_backfill_writes_checkpoints_readable_via_public_repository_api(tmp_path, postgres_url):
    mod = _module()
    postgres = importlib.import_module("agent_telemetry.db.postgres")
    db_path = tmp_path / "kanban.db"
    _make_kanban_db(db_path)
    scope = f"p_backfilltest_{int(time.time())}"

    repository = postgres.PostgresMetricsRepository(postgres_url)
    await repository.open()
    try:
        await repository.migrate()
        written = await mod.backfill(kanban_db_path=str(db_path), scope=scope, repository=repository)
        assert written == 3

        agent_ids = await repository.list_scope_agent_ids(scope=scope)
        assert set(agent_ids) == {"builder", "reviewer"}
    finally:
        await repository.close()
