#!/usr/bin/env python3
"""Kanban decision-resolution sweeper: links a resolved Decision HUD card
back to the kanban task it escalated from.

Pairs with kanban_escalation_bridge.py — that script spawns a classifier
task when a kanban card blocks/needs review; the classifier pushes one or
more decision_hud cards, each stamped with:
    card_payload._kanban_task_id = "<original task id>"
    card_payload._kanban_status  = "blocked" | "review"
(same convention as the existing missing_constraint mechanism: reuse
card_payload, no new schema — decision-hud-cards' schema-fragmentation cap).

This script is a CRON-scheduled polling sweep (not a hook — resolution
happens whenever the owner opens the Decision HUD pane, asynchronously,
possibly hours later, so there's no lifecycle event to hang a hook off of).

Behavior:
  - status == 'blocked': only auto-unblocks once EVERY decision pushed for
    that task_id (the classifier may have split one blocker into several
    independent cards — see kanban_escalation_bridge.py's handoff prompt)
    is resolved. Partial resolution posts a progress comment but does not
    unblock — a still-open sibling card means the real blocker isn't lifted
    yet, and unblocking early would let the worker proceed on an unanswered
    half of the decision.
  - status == 'review': never auto-transitions (review's terminal action is
    a human/reviewer calling kanban_complete/kanban_request_changes, not a
    status flip this script owns) — just posts a comment linking the
    resolution so the reviewer has it without hunting the HUD.
  - Idempotent via a local state file keyed by decision id, so a decision
    already turned into a comment/unblock is never re-processed on the next
    sweep tick.

Wire into cron (hermes cron / cronjob_manage), e.g. every 5 minutes:
    kanban_decision_resolution_sweeper.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

STATE_FILE = Path.home() / ".hermes" / "kanban_decision_resolution_state.json"

# decision-hud plugin's db module — imported directly (read-only queries),
# matching the plugin's own supported read API (same import path
# card-type-gate/decision-hud-cards scripts already use); mutations to
# kanban state still go exclusively through the `hermes kanban` CLI.
_DB_PLUGIN_DIR = Path.home() / ".hermes" / "plugins" / "decision-hud"


def _load_db_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("decision_hud_db", _DB_PLUGIN_DIR / "db.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def current_task(task_id: str) -> dict | None:
    """Fetch + flatten `hermes kanban show --json`'s nested response shape
    ({"task": {...}, "events": [...], ...}) — matches the same fix applied
    to kanban_escalation_bridge.py's current_task() after the live canary
    showed task fields live under "task", not the response root."""
    raw = run_cli(["hermes", "kanban", "show", task_id, "--json"])
    if not raw or "task" not in raw:
        return None
    flat = dict(raw["task"])
    flat["events"] = raw.get("events") or []
    return flat


def log(msg: str) -> None:
    print(f"[kanban-decision-sweeper] {msg}", file=sys.stderr)


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
    """Run a `hermes kanban ...` CLI call. `comment`/`unblock` have NO --json
    flag at all (verified live) and print plain text on success — a clean
    exit with non-JSON stdout is {"ok": True, "raw": stdout}, not a failure."""
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


def linked_decisions(conn, db) -> list[dict]:
    """All Kanban-linked decisions, including grouped plural-link cards."""
    rows = conn.execute(
        "SELECT * FROM decisions WHERE json_extract(card_payload_json, '$._kanban_task_id') IS NOT NULL "
        "OR json_extract(card_payload_json, '$._kanban_task_ids') IS NOT NULL"
    ).fetchall()
    return [db._row_to_dict(row) for row in rows]


def origin_decisions(conn, db) -> list[dict]:
    """Standalone decisions (no kanban task) that captured an origin chat at
    push time (see decision_hud/db.py::push_decision's _origin_platform /
    _origin_chat_id capture) — the only delivery path for a decision that
    didn't come from a kanban escalation."""
    rows = conn.execute(
        "SELECT * FROM decisions WHERE json_extract(card_payload_json, '$._origin_chat_id') IS NOT NULL "
        "AND json_extract(card_payload_json, '$._kanban_task_id') IS NULL"
    ).fetchall()
    return [db._row_to_dict(row) for row in rows]


def process_origin_decision(d: dict, state: dict) -> None:
    if not d.get("resolved_at") or state.get(d["id"]):
        return  # only newly-resolved, unseen decisions
    payload = d.get("card_payload") or {}
    platform, chat_id = payload.get("_origin_platform"), payload.get("_origin_chat_id")
    thread_id = payload.get("_origin_thread_id")
    target = f"{platform}:{chat_id}" + (f":{thread_id}" if thread_id else "")
    message = f"Decision resolved: {d['question']!r} -> {d.get('resolved_choice') or '(no choice recorded)'}"
    result = run_cli(["hermes", "send", "-t", target, message])
    if result:
        log(f"delivered resolution for {d['id']} to {target}")
    state[d["id"]] = True
    save_state(state)


def group_by_task(decisions: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for d in decisions:
        payload = d.get("card_payload") or {}
        task_ids = payload.get("_kanban_task_ids")
        if task_ids is None:
            task_ids = [payload.get("_kanban_task_id")]
        if not isinstance(task_ids, list):
            continue
        status = payload.get("_kanban_status")
        if status not in {"blocked", "review"}:
            continue
        for task_id in dict.fromkeys(str(value).strip() for value in task_ids if isinstance(value, str) and value.strip()):
            linked = dict(d)
            linked["card_payload"] = dict(payload)
            linked["card_payload"]["_kanban_task_id"] = task_id
            linked["card_payload"]["_kanban_status"] = status
            groups.setdefault(task_id, []).append(linked)
    return groups


def can_unblock(cards: list[dict]) -> bool:
    """Only an explicit, versioned structured approval can mutate Kanban."""
    if not cards or any(not c.get("resolved_at") for c in cards):
        return False
    policies = []
    for card in cards:
        payload = card.get("card_payload") or {}
        policy = payload.get("_kanban_resolution")
        result = card.get("resolved_payload")
        if payload.get("_triage_contract_version") != 1 or not isinstance(policy, dict):
            return False
        if policy.get("contract_version") != 1 or not isinstance(result, dict):
            return False
        if result.get("contract_version") != 1:
            return False
        action = result.get("action")
        if action not in {"unblock", "leave_blocked"} or action not in policy.get("actions", {}).values():
            return False
        policies.append(action)
    return all(action == "unblock" for action in policies)


def summarize_resolution(cards: list[dict]) -> str:
    lines = []
    for c in cards:
        status = "resolved" if c.get("resolved_at") else "pending"
        choice = c.get("resolved_choice") or "(unresolved)"
        lines.append(f"- [{status}] {c['question']!r} -> {choice}")
    return "\n".join(lines)


def process_task_group(task_id: str, cards: list[dict], state: dict) -> None:
    unresolved = [c for c in cards if not c.get("resolved_at")]
    newly_resolved = [
        c for c in cards
        if c.get("resolved_at") and not state.get(c["id"])
    ]
    if not newly_resolved:
        return  # nothing new to report this tick

    payload = cards[0].get("card_payload") or {}
    kanban_status = payload.get("_kanban_status")

    if unresolved:
        # Partial: comment progress, do not unblock/transition yet.
        run_cli([
            "hermes", "kanban", "comment", task_id,
            f"Decision HUD: {len(cards) - len(unresolved)}/{len(cards)} linked decisions "
            f"resolved so far:\n{summarize_resolution(cards)}",
        ])
        for c in newly_resolved:
            state[c["id"]] = True
        save_state(state)
        return

    # All resolved.
    run_cli([
        "hermes", "kanban", "comment", task_id,
        f"Decision HUD: all {len(cards)} linked decision(s) resolved:\n{summarize_resolution(cards)}",
    ])
    if kanban_status == "blocked" and can_unblock(cards):
        task = current_task(task_id)
        if task and task.get("status") == "blocked":
            result = run_cli(["hermes", "kanban", "unblock", task_id])
            if result:
                log(f"unblocked {task_id} after all linked decisions resolved")
        else:
            log(f"{task_id} no longer 'blocked' (status={task.get('status') if task else '?'}); skipping unblock")
    # status == 'review': comment only, never auto-transition (see module docstring).

    for c in newly_resolved:
        state[c["id"]] = True
    save_state(state)


def sweep() -> None:
    db = _load_db_module()
    conn = db.connect()
    try:
        decisions = linked_decisions(conn, db)
        origins = origin_decisions(conn, db)
    finally:
        conn.close()

    state = load_state()
    groups = group_by_task(decisions)
    for task_id, cards in groups.items():
        process_task_group(task_id, cards, state)
    for d in origins:
        process_origin_decision(d, state)


if __name__ == "__main__":
    sweep()
