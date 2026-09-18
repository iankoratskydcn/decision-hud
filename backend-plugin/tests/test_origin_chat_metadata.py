"""Regression tests for standalone decision origin metadata capture."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _conn(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "queue.db"))
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def _projects_db(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "projects.db"))
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    )
    conn.execute("INSERT INTO projects VALUES ('p_test', 'test', 'Test', 0, 0)")
    conn.commit()
    conn.close()


def test_push_decision_captures_origin_without_overwriting_payload(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _projects_db(tmp_path)
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")
    monkeypatch.setenv("HERMES_SESSION_THREAD_ID", "thread-9")

    conn = _conn(tmp_path)
    result = db.push_decision(
        conn,
        project_id="p_test",
        question="Proceed?",
        choices=["yes", "no"],
        card_payload={"context": "kept", "_origin_chat_id": "authoritative-chat"},
    )

    assert result["card_payload"] == {
        "context": "kept",
        "_origin_chat_id": "authoritative-chat",
        "_origin_platform": "telegram",
        "_origin_thread_id": "thread-9",
    }


def test_push_decision_without_origin_keeps_payload_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _projects_db(tmp_path)
    for key in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_ID", "HERMES_SESSION_THREAD_ID"):
        monkeypatch.delenv(key, raising=False)

    conn = _conn(tmp_path)
    result = db.push_decision(
        conn,
        project_id="p_test",
        question="Proceed?",
        choices=["yes", "no"],
    )

    assert result["card_payload"] is None
