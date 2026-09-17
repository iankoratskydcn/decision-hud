"""RED: db.py's _resolve_project() must match either the real project id
(p_xxxxxxxx) OR its slug, exactly like hermes_cli.projects_db.get_project()
does. decision-hud deliberately doesn't import hermes_cli (see db.py module
docstring) so it re-implements the lookup with raw SQL against projects.db
-- but the current implementation only matches `id`, silently dropping the
slug half of that contract. Kanban's batch_approval_gate stores an
operator-typed slug (e.g. "shattered-flames"), not the internal p_xxxxxxxx
id, so every real dispatch-side gate call fails closed with "unknown
project" even when the project obviously exists.
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _mkprojects_db(tmp_path, rows):
    path = tmp_path / "projects.db"
    conn = sqlite3.connect(str(path))
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)"
    )
    conn.executemany(
        "INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", rows
    )
    conn.commit()
    conn.close()
    return path


def test_resolve_project_matches_by_id(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _mkprojects_db(tmp_path, [("p_abc123", "shattered-flames", "Shattered Flames")])
    result = db._resolve_project("p_abc123")
    assert result == {"id": "p_abc123", "slug": "shattered-flames", "name": "Shattered Flames"}


def test_resolve_project_matches_by_slug(tmp_path, monkeypatch):
    """The real gap: kanban board_metadata stores the human slug, not the
    internal id, in batch_approval_gate.project -- this must resolve."""
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _mkprojects_db(tmp_path, [("p_abc123", "shattered-flames", "Shattered Flames")])
    result = db._resolve_project("shattered-flames")
    assert result == {"id": "p_abc123", "slug": "shattered-flames", "name": "Shattered Flames"}


def test_resolve_project_unknown_still_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _mkprojects_db(tmp_path, [("p_abc123", "shattered-flames", "Shattered Flames")])
    try:
        db._resolve_project("nonexistent")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "does not match any known project" in str(exc)


if __name__ == "__main__":
    import tempfile
    from types import SimpleNamespace

    passed = 0
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as d:
                tmp_path = Path(d)

                class _MP:
                    def setattr(self, obj, attr, val):
                        setattr(obj, attr, val)

                try:
                    fn(tmp_path, _MP())
                    print(f"PASS {name}")
                    passed += 1
                except AssertionError as e:
                    print(f"FAIL {name}: {e}")
                    failed += 1
                except Exception as e:
                    print(f"ERROR {name}: {e}")
                    failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
