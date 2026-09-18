#!/usr/bin/env python3
"""Unit tests for kanban_decision_resolution_sweeper.py — pure-function
logic only; no live kanban/decision store touched (run_cli mocked)."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).parent / "kanban_decision_resolution_sweeper.py"
_spec = importlib.util.spec_from_file_location("kanban_decision_resolution_sweeper", _MODULE_PATH)
sweeper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sweeper)


def _card(id_, task_id, status="blocked", resolved=False, question="Q?", choice=None):
    return {
        "id": id_,
        "question": question,
        "resolved_at": 1.0 if resolved else None,
        "resolved_choice": choice,
        "card_payload": {"_kanban_task_id": task_id, "_kanban_status": status},
    }


def _action_card(id_, task_id, action, resolved=True):
    card = _card(id_, task_id, resolved=resolved, choice=action)
    action_key = {"Unblock after verification": "unblock", "Leave blocked": "leave_blocked"}[action]
    card["card_payload"]["_triage_contract_version"] = 1
    card["card_payload"]["_kanban_resolution"] = {
        "actions": {"Unblock after verification": "unblock", "Leave blocked": "leave_blocked"},
        "contract_version": 1,
    }
    card["resolved_payload"] = {"action": action_key, "contract_version": 1}
    return card


class GroupByTaskTests(unittest.TestCase):
    def test_groups_multiple_cards_under_one_task(self):
        cards = [_card("d1", "task-1"), _card("d2", "task-1"), _card("d3", "task-2")]
        groups = sweeper.group_by_task(cards)
        self.assertEqual(set(groups.keys()), {"task-1", "task-2"})
        self.assertEqual(len(groups["task-1"]), 2)
        self.assertEqual(len(groups["task-2"]), 1)

    def test_cards_without_link_are_excluded(self):
        cards = [{"card_payload": {}}, {"card_payload": None}, _card("d1", "task-1")]
        groups = sweeper.group_by_task(cards)
        self.assertEqual(list(groups.keys()), ["task-1"])


class ProcessTaskGroupTests(unittest.TestCase):
    def test_partial_resolution_comments_but_does_not_unblock(self):
        cards = [
            _card("d1", "task-1", resolved=True, choice="postgres"),
            _card("d2", "task-1", resolved=False),
        ]
        state = {}
        calls = []
        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}):
            sweeper.process_task_group("task-1", cards, state)
        comment_calls = [c for c in calls if "comment" in c]
        unblock_calls = [c for c in calls if "unblock" in c]
        self.assertEqual(len(comment_calls), 1)
        self.assertEqual(len(unblock_calls), 0)
        self.assertIn("d1", state)
        self.assertNotIn("d2", state)  # unresolved card never marked processed

    def test_full_resolution_on_blocked_task_unblocks(self):
        cards = [
            _action_card("d1", "task-1", "Unblock after verification"),
            _action_card("d2", "task-1", "Unblock after verification"),
        ]
        state = {}
        calls = []

        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}), \
             mock.patch.object(sweeper, "current_task", return_value={"status": "blocked"}):
            sweeper.process_task_group("task-1", cards, state)

        unblock_calls = [c for c in calls if "unblock" in c]
        self.assertEqual(len(unblock_calls), 1)
        self.assertEqual(unblock_calls[0][3], "task-1")
        self.assertIn("d1", state)
        self.assertIn("d2", state)

    def test_leave_blocked_never_unblocks(self):
        cards = [_action_card("d1", "task-1", "Leave blocked")]
        calls = []
        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}), \
             mock.patch.object(sweeper, "current_task", return_value={"status": "blocked"}):
            sweeper.process_task_group("task-1", cards, {})
        self.assertFalse(any("unblock" in c for c in calls))

    def test_legacy_resolution_never_unblocks(self):
        cards = [_card("d1", "task-1", resolved=True, choice="approved")]
        calls = []
        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}), \
             mock.patch.object(sweeper, "current_task", return_value={"status": "blocked"}):
            sweeper.process_task_group("task-1", cards, {})
        self.assertFalse(any("unblock" in c for c in calls))

    def test_full_resolution_on_review_task_never_unblocks(self):
        cards = [_card("d1", "task-1", status="review", resolved=True, choice="lgtm")]
        state = {}
        calls = []
        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}), \
             mock.patch.object(sweeper, "current_task") as current_task_mock:
            sweeper.process_task_group("task-1", cards, state)
        unblock_calls = [c for c in calls if "unblock" in c]
        self.assertEqual(len(unblock_calls), 0)
        current_task_mock.assert_not_called()  # never even checks status for review

    def test_already_processed_decision_is_not_recommented(self):
        cards = [_card("d1", "task-1", resolved=True, choice="postgres")]
        state = {"d1": True}  # already processed on a prior sweep
        calls = []
        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}):
            sweeper.process_task_group("task-1", cards, state)
        self.assertEqual(calls, [])  # nothing new -> no CLI calls at all

    def test_task_no_longer_blocked_skips_unblock_call(self):
        # Task may have been unblocked manually/by another mechanism between
        # sweeps — must not call unblock on a non-blocked task.
        cards = [_card("d1", "task-1", resolved=True, choice="postgres")]
        state = {}
        calls = []

        with mock.patch.object(sweeper, "run_cli", side_effect=lambda args: calls.append(args) or {"ok": True}), \
             mock.patch.object(sweeper, "current_task", return_value={"status": "running"}):
            sweeper.process_task_group("task-1", cards, state)
        unblock_calls = [c for c in calls if "unblock" in c]
        self.assertEqual(len(unblock_calls), 0)


class SummarizeResolutionTests(unittest.TestCase):
    def test_shows_resolved_and_pending_status(self):
        cards = [
            _card("d1", "task-1", resolved=True, choice="postgres", question="DB?"),
            _card("d2", "task-1", resolved=False, question="Region?"),
        ]
        summary = sweeper.summarize_resolution(cards)
        self.assertIn("[resolved]", summary)
        self.assertIn("postgres", summary)
        self.assertIn("[pending]", summary)
        self.assertIn("(unresolved)", summary)


class StateFilePersistenceTests(unittest.TestCase):
    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "state.json"
            with mock.patch.object(sweeper, "STATE_FILE", state_file):
                sweeper.save_state({"d1": True})
                self.assertEqual(sweeper.load_state(), {"d1": True})

    def test_load_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "missing.json"
            with mock.patch.object(sweeper, "STATE_FILE", state_file):
                self.assertEqual(sweeper.load_state(), {})


if __name__ == "__main__":
    unittest.main()
