"""RED: tests for db.py's server-side card_type verification.

Goal: a caller can no longer just assert card_type="whatever" on
push_decision — if card_type is set, card_type_bucket + card_type_answers
must ALSO be given, and db.py runs the SAME deterministic rule engine as
card-type-gate's scripts/card_type_selector.py against them. The push is
rejected (ValueError) unless the engine's own verdict resolves to exactly
the claimed card_type. This makes the classifier load-bearing instead of
advisory prose in a skill doc.

Isolated from the live queue.db entirely: every test uses tmp_path.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _mkconn(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = db.connect()
    return conn


def _mkproject(tmp_path):
    """Create a real project row in the actual projects.db _resolve_project
    reads (tmp_path/projects.db, independent of the decisions-queue db.py
    opens via db.connect() — _resolve_project always targets
    _hermes_home()/projects.db, which IS patched to tmp_path here)."""
    import sqlite3
    import uuid
    projects_db_path = tmp_path / "projects.db"
    conn = sqlite3.connect(str(projects_db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    pid = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", (pid, "p", "P"))
    conn.commit()
    conn.close()
    return pid


def test_push_without_card_type_never_needs_bucket_or_answers(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    # No card_type at all -> always allowed, no verification needed.
    row = db.push_decision(conn, project_id=pid, question="q?", choices=["a", "b"])
    assert row["card_type"] is None


def test_push_with_card_type_but_no_bucket_answers_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(conn, project_id=pid, question="q?", choices=["a", "b"],
                          card_type="scalar_slider")
        assert False, "expected ValueError: card_type without bucket/answers must be rejected"
    except ValueError as exc:
        assert "card_type_bucket" in str(exc) or "card_type_answers" in str(exc)


def test_push_with_card_type_matching_engine_verdict_succeeds(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    row = db.push_decision(
        conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
        card_type="scalar_slider",
        card_type_bucket="scalar",
        card_type_answers={
            "is_interval_not_point": False,
            "is_fixed_total_split": False,
            "needs_confidence_axis": False,
            # The engine requires the full discriminant set for the bucket
            # (union across every rule in "scalar"), not just the keys the
            # matched rule happens to use — prefers_visual_segments is only
            # read by constrained_budget_split/stacked_bar_split, but must
            # still be answered to resolve unambiguously. See db.py's
            # _card_type_verdict: `needed = {q for _, reqs in bucket_rules
            # for q in reqs}`.
            "prefers_visual_segments": False,
        },
    )
    assert row["card_type"] == "scalar_slider"


def test_push_with_card_type_NOT_matching_engine_verdict_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(
            conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
            card_type="quad_choice",  # claiming quad_choice while answers resolve to scalar_slider
            card_type_bucket="scalar",
            card_type_answers={
                "is_interval_not_point": False,
                "is_fixed_total_split": False,
                "needs_confidence_axis": False,
                "prefers_visual_segments": False,
            },
        )
        assert False, "expected ValueError: claimed card_type must match the engine's resolved card_type"
    except ValueError as exc:
        assert "quad_choice" in str(exc) and "scalar_slider" in str(exc)


def test_push_with_incomplete_answers_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(
            conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
            card_type="scalar_slider",
            card_type_bucket="scalar",
            card_type_answers={"is_interval_not_point": False},  # missing 2 more discriminants
        )
        assert False, "expected ValueError: incomplete discriminant answers must be rejected, never silently accepted"
    except ValueError as exc:
        assert "incomplete" in str(exc).lower()


def test_push_with_none_of_these_bucket_needs_zero_answers(tmp_path, monkeypatch):
    """The mandatory fast-bypass bucket: card_type=mcq_context with
    bucket=none_of_these and an EMPTY answers dict must succeed — this is
    the scripted zero-question exit every gate must have."""
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    row = db.push_decision(
        conn, project_id=pid, question="Anything not fitting a shape", choices=["Ok", "Not now"],
        card_type="mcq_context",
        card_type_bucket="none_of_these",
        card_type_answers={},
    )
    assert row["card_type"] == "mcq_context"


if __name__ == "__main__":
    import tempfile
    from pathlib import Path as _P

    failures = []
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as td:
                tmp_path = _P(td)
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
        print(f"\n{len(failures)} failing (expected pre-implementation): {failures}")
    else:
        print("\nall pass")
