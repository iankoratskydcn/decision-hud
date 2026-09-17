"""RED: v6 schema — decisions.project (free text) -> decisions.project_id
(FK-validated against the real projects.db). This is a deliberate breaking
cutover (owner decision: existing rows are disposable test data; no backfill).

Isolated from the live queue.db entirely: every test builds its own
throwaway sqlite3 connection against tmp_path, and its own throwaway
projects.db to validate against (monkeypatching _hermes_home so
_resolve_project()'s lookup targets it instead of the real one).
"""

from __future__ import annotations

import sqlite3
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _conn(tmp_path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(tmp_path / "test_queue.db"))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=5000")
    db.init_db(c)
    return c


def _make_projects_db(tmp_path: Path, projects: list[tuple[str, str, str]]) -> None:
    """projects: list of (id, slug, name). Mirrors hermes_cli.projects_db's
    real schema closely enough for _resolve_project()'s read-only lookup."""
    p = tmp_path / "projects.db"
    conn = sqlite3.connect(str(p))
    conn.execute(
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        )
        """
    )
    for pid, slug, name in projects:
        conn.execute(
            "INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
            (pid, slug, name, int(time.time())),
        )
    conn.commit()
    conn.close()


def test_push_decision_requires_a_real_project_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_abc123", "tbcaf", "TBCAF")])
    conn = _conn(tmp_path)

    result = db.push_decision(conn, project_id="p_abc123", question="q?", choices=["a", "b"])
    assert result["project_id"] == "p_abc123"
    assert result["project_slug"] == "tbcaf"
    assert result["project_name"] == "TBCAF"


def test_push_decision_rejects_unknown_project_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_abc123", "tbcaf", "TBCAF")])
    conn = _conn(tmp_path)

    try:
        db.push_decision(conn, project_id="p_does_not_exist", question="q?", choices=["a", "b"])
        assert False, "expected ValueError for an unknown project_id"
    except ValueError as exc:
        assert "p_does_not_exist" in str(exc)


def test_push_decision_rejects_empty_project_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [])
    conn = _conn(tmp_path)
    try:
        db.push_decision(conn, project_id="", question="q?", choices=["a", "b"])
        assert False, "expected ValueError for an empty project_id"
    except ValueError:
        pass


def test_list_pending_returns_project_slug_and_name_for_display(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_1", "tbcaf", "TBCAF"), ("p_2", "bellini", "Bellini")])
    conn = _conn(tmp_path)
    db.push_decision(conn, project_id="p_1", question="q1?", choices=["a", "b"])
    db.push_decision(conn, project_id="p_2", question="q2?", choices=["a", "b"])

    rows = db.list_pending(conn)
    by_id = {r["project_id"]: r for r in rows}
    assert by_id["p_1"]["project_slug"] == "tbcaf"
    assert by_id["p_2"]["project_name"] == "Bellini"


def test_list_pending_filters_by_project_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_1", "tbcaf", "TBCAF"), ("p_2", "bellini", "Bellini")])
    conn = _conn(tmp_path)
    db.push_decision(conn, project_id="p_1", question="q1?", choices=["a", "b"])
    db.push_decision(conn, project_id="p_2", question="q2?", choices=["a", "b"])

    rows = db.list_pending(conn, project_id="p_1")
    assert len(rows) == 1
    assert rows[0]["project_id"] == "p_1"


def test_list_projects_returns_real_project_rows_with_pending_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_1", "tbcaf", "TBCAF"), ("p_2", "bellini", "Bellini")])
    conn = _conn(tmp_path)
    db.push_decision(conn, project_id="p_1", question="q1?", choices=["a", "b"])
    db.push_decision(conn, project_id="p_1", question="q2?", choices=["a", "b"])
    db.push_decision(conn, project_id="p_2", question="q3?", choices=["a", "b"])

    rows = {r["project_id"]: r for r in db.list_projects(conn)}
    assert rows["p_1"]["pending"] == 2
    assert rows["p_1"]["slug"] == "tbcaf"
    assert rows["p_2"]["pending"] == 1


def test_push_problem_report_requires_a_real_project_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_1", "tbcaf", "TBCAF")])
    conn = _conn(tmp_path)

    result = db.push_problem_report(conn, project_id="p_1", problem="stuck on auth")
    assert result["project_id"] == "p_1"

    try:
        db.push_problem_report(conn, project_id="p_nope", problem="stuck")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_v6_migration_drops_legacy_project_text_rows(tmp_path, monkeypatch):
    """Owner decision: no backfill. A pre-v6 db (free-text `project` column,
    populated with disposable test rows) is wiped clean on first v6 open —
    the table is recreated with project_id instead, not migrated in place."""
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path, [("p_1", "tbcaf", "TBCAF")])
    dbfile = tmp_path / "test_queue.db"
    legacy = sqlite3.connect(str(dbfile))
    legacy.execute(
        "CREATE TABLE decisions (id TEXT PRIMARY KEY, project TEXT NOT NULL, question TEXT NOT NULL, "
        "choices_json TEXT NOT NULL, recommended TEXT, urgency TEXT NOT NULL DEFAULT 'normal', "
        "created_at REAL NOT NULL, resolved_choice TEXT, resolved_at REAL)"
    )
    legacy.execute(
        "INSERT INTO decisions (id, project, question, choices_json, urgency, created_at) "
        "VALUES ('old1', 'free-text-project', 'legacy question?', '[\"a\",\"b\"]', 'normal', 0)"
    )
    legacy.commit()
    legacy.close()

    conn = sqlite3.connect(str(dbfile))
    conn.row_factory = sqlite3.Row
    db.init_db(conn)  # v6 migration runs here

    cols = {r["name"] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    assert "project_id" in cols
    assert "project" not in cols
    assert conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == 0

    # Fresh pushes against the recreated table work normally.
    result = db.push_decision(conn, project_id="p_1", question="new?", choices=["a", "b"])
    assert result["project_id"] == "p_1"


if __name__ == "__main__":
    import tempfile

    failures = []
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as td:
                tmp_path = Path(td)
                _patched = []

                class _MP:
                    def setattr(self, obj, attr, val):
                        _patched.append((obj, attr, getattr(obj, attr)))
                        setattr(obj, attr, val)
                mp = _MP()
                try:
                    fn(tmp_path, mp)
                    print(f"PASS {name}")
                except AssertionError as e:
                    print(f"FAIL {name}: {e}")
                    failures.append(name)
                except Exception as e:
                    print(f"ERROR {name}: {type(e).__name__}: {e}")
                    failures.append(name)
                finally:
                    for obj, attr, orig in reversed(_patched):
                        setattr(obj, attr, orig)
    if failures:
        print(f"\n{len(failures)} failing: {failures}")
    else:
        print("\nall pass")
