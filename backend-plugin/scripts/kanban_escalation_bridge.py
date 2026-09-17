#!/usr/bin/env python3
"""Kanban escalation bridge: kanban_task_blocked / on_kanban_task_updated hook.

Forked from the kanban_column_observer.py scaffold (same per-task
prev-status diffing, since Hermes hooks fire on EVENTS not columns and
there is no dedicated "entered review" hook yet).

Job of this script (deliberately narrow — see decision-hud-cards skill,
"card-type-gate": classification needs real reasoning, a sync hook has
none):
  1. Detect a transition into 'blocked' (kind='needs_input' only) or,
     when scope='all', into 'review'.
  2. Filter by the persisted kanban_escalation_bridge_scope setting
     ('off' | 'needs_input' | 'all') so the owner can change policy from
     the Decision HUD pane without touching this file.
  3. Hand off to a classifier kanban task (assignee=decision-bridge)
     instead of classifying inline. That task runs card_type_gate with
     real context and may push MULTIPLE decision_hud cards if the
     blocker actually bundles independent decisions — never force-fits
     one card_type across unrelated axes.

Idempotency: a small local state file remembers which (task_id, status)
pairs already got a classifier task, so a retried/duplicate hook fire
(e.g. two rapid on_kanban_task_updated events for the same transition)
never spawns two classifier tasks for the same blocker.

Wire into ~/.hermes/config.yaml:

hooks:
  kanban_task_blocked:
    - script: ~/.hermes/scripts/kanban_escalation_bridge.py
  on_kanban_task_updated:
    - script: ~/.hermes/scripts/kanban_escalation_bridge.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

STATE_FILE = Path.home() / ".hermes" / "kanban_escalation_bridge_state.json"
CLASSIFIER_ASSIGNEE = "decision-bridge"

# Reasons that are pure STATUS, never a decision — never escalate these
# even at scope='all'. Kept as a set (not folded into the CLI's own
# 'kind' enum) because this bridge's exclusion list is a policy choice
# specific to Decision HUD escalation, not a kanban-core distinction.
_NON_DECISION_KINDS = {"capability", "transient", "dependency"}


def log(msg: str) -> None:
    print(f"[kanban-escalation-bridge] {msg}", file=sys.stderr)


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def run_cli(args: list[str]) -> dict | None:
    """Run a `hermes kanban ...` CLI call. Some subcommands (comment, unblock)
    have NO --json flag at all (verified live: passing --json to either is an
    argparse error) and print plain text on success — treat a clean exit with
    non-JSON stdout as {"ok": True, "raw": stdout}, not a failure. Only a
    non-zero exit or truly malformed invocation counts as failed."""
    try:
        result = subprocess.run(args, capture_output=True, text=True, check=True)
    except Exception as exc:
        log(f"CLI call failed ({' '.join(args)}): {exc}")
        return None
    stdout = result.stdout.strip()
    if not stdout:
        return {"ok": True}
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return {"ok": True, "raw": stdout}


def get_scope() -> str:
    """Read kanban_escalation_bridge_scope; default matches cli.py's
    _SETTINGS_KEYS default so a first-run/unset store behaves the same
    as the persisted default would."""
    res = run_cli(["hermes", "decision", "settings-get"])
    if not res or not res.get("ok"):
        return "needs_input"
    return (res.get("settings") or {}).get("kanban_escalation_bridge_scope", "needs_input")


def current_task(task_id: str) -> dict | None:
    """Fetch + flatten `hermes kanban show --json`'s response shape
    ({"task": {...}, "events": [...], ...}) into one dict with `status`,
    `events`, etc. at the top level — verified live (canary run) that the
    real response nests task fields under "task", not at the root; reading
    task.get("status") directly always returned None before this flatten."""
    raw = run_cli(["hermes", "kanban", "show", task_id, "--json"])
    if not raw or "task" not in raw:
        return None
    flat = dict(raw["task"])
    flat["events"] = raw.get("events") or []
    flat["latest_summary"] = raw.get("latest_summary")
    return flat


def _latest_block_payload(task: dict) -> dict:
    """block_kind/reason are NOT on the task row itself (verified live: the
    `show --json` task object has no such keys) — they live in the payload
    of the most recent 'blocked' event. Walk events newest-first."""
    for event in reversed(task.get("events") or []):
        if event.get("kind") == "blocked":
            return event.get("payload") or {}
    return {}


def should_escalate(scope: str, status: str, task: dict) -> bool:
    if scope == "off":
        return False
    if status == "blocked":
        kind = _latest_block_payload(task).get("kind")
        if kind in _NON_DECISION_KINDS:
            return False
        return True  # needs_input (or unset/legacy blocks without a kind) escalates at both scopes
    if status == "review":
        return scope == "all"
    return False


def spawn_classifier(task_id: str, status: str, task: dict) -> None:
    title = f"Classify decision for {task_id} ({status})"
    reason = _latest_block_payload(task).get("reason") or task.get("latest_summary") or ""
    body = (
        f"Kanban escalation bridge: task {task_id} entered '{status}'.\n\n"
        f"Reason: {reason}\n\n"
        "Run the card-type-gate discriminant engine on the real decision "
        "buried in this blocker/review, then push to decision_hud with the "
        "resolved card_type. If the blocker bundles more than one independent "
        "decision (e.g. two unrelated axes), push separate decision_hud cards "
        "for each rather than forcing one card_type to carry both.\n\n"
        f"Set card_payload._kanban_task_id={task_id!r} and "
        f"card_payload._kanban_status={status!r} on every card you push for "
        "this task, so resolution can unblock/notify it (see decision-hud-cards skill)."
    )
    res = run_cli([
        "hermes", "kanban", "create", title,
        "--assignee", CLASSIFIER_ASSIGNEE, "--body", body,
        "--parent", task_id, "--workspace", "scratch", "--json",
    ])
    if res and res.get("id"):
        log(f"spawned classifier task {res.get('id')} for {task_id} ({status})")
    else:
        log(f"failed to spawn classifier task for {task_id} ({status})")


def handle_event(task_id: str, payload: dict) -> None:
    if not task_id:
        return
    state = load_state()
    task = current_task(task_id)
    if task is None:
        return
    status = task.get("status")
    if status not in ("blocked", "review"):
        return

    dedupe_key = f"{task_id}:{status}"
    if state.get(dedupe_key):
        return  # already spawned a classifier for this exact transition

    scope = get_scope()
    if not should_escalate(scope, status, task):
        return

    spawn_classifier(task_id, status, task)
    state[dedupe_key] = True
    save_state(state)


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    handle_event(task_id=payload.get("task_id"), payload=payload)
