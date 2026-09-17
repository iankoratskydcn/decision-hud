#!/usr/bin/env python3
"""Ensure every named Hermes profile has the kanban escalation-bridge hooks.

Why this exists: kanban worker profiles (reviewer, builder, security-engineer,
...) each run as `hermes -p <profile> --cli chat -q "work kanban task ..."` —
a separate process scoped to THAT profile's own ~/.hermes/profiles/<name>/
config.yaml. Hooks are per-profile by design (profiles are isolated islands,
no live config inheritance — see hermes-agent AGENTS.md). The default
profile's config.yaml having `hooks: kanban_task_blocked: ...` does nothing
for a task a worker profile blocks; that hook fires (or doesn't) in the
worker's own process using the worker's own config.

This script is idempotent and additive-only (mirrors skills_sync.py's
posture): for every named profile under ~/.hermes/profiles/ that has an
identity marker (config.yaml exists) and is missing the
kanban_task_blocked / on_kanban_task_updated hook entries, append them plus
hooks_auto_accept: true. Never touches a profile that already has its own
hooks: block for these events (so a profile that customized/removed them on
purpose is left alone) — it only fills a genuine gap.

Run via cron (see kanban_profile_hooks_sync cron job) so a newly created
profile is caught within one tick, not a manual step someone forgets.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

PROFILES_ROOT = Path.home() / ".hermes" / "profiles"
BRIDGE_CMD = (
    "/home/ian-koratsky/hermes-agent/.venv/bin/python3 "
    "/home/ian-koratsky/.hermes/scripts/kanban_escalation_bridge.py"
)
_TARGET_EVENTS = ("kanban_task_blocked", "on_kanban_task_updated")

# Profiles that legitimately never run kanban tasks (nothing to escalate) or
# are managed separately — skip so we don't cargo-cult hooks onto irrelevant
# profiles. Empty for now; add names here if a profile should be exempt.
_SKIP_PROFILES: set[str] = set()


def _has_identity(profile_dir: Path) -> bool:
    """Same marker set as hermes_constants.named_profile_has_identity."""
    return any(
        (profile_dir / name).exists()
        for name in ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
    )


def _needs_patch(cfg: dict) -> bool:
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        return True
    return not all(event in hooks for event in _TARGET_EVENTS)


def sync_profile(profile_dir: Path) -> str:
    """Returns 'patched', 'skipped', or 'ok'."""
    name = profile_dir.name
    if name in _SKIP_PROFILES or name.startswith("."):
        return "skipped"
    if not _has_identity(profile_dir):
        return "skipped"

    config_path = profile_dir / "config.yaml"
    if config_path.is_symlink() or not config_path.exists():
        # Symlinked/shared config (e.g. a clone that intentionally shares
        # the source's config) — never write through it from here.
        return "skipped"

    try:
        raw = config_path.read_text(encoding="utf-8")
        cfg = yaml.safe_load(raw) or {}
    except Exception as exc:
        print(f"  ✗ {name}: failed to read/parse config.yaml: {exc}", file=sys.stderr)
        return "skipped"

    if not isinstance(cfg, dict):
        print(f"  ✗ {name}: config.yaml did not parse to a mapping, skipping", file=sys.stderr)
        return "skipped"

    if not _needs_patch(cfg):
        return "ok"

    hooks = cfg.setdefault("hooks", {})
    for event in _TARGET_EVENTS:
        entries = hooks.setdefault(event, [])
        if not any(isinstance(e, dict) and e.get("command") == BRIDGE_CMD for e in entries):
            entries.append({"command": BRIDGE_CMD})
    cfg.setdefault("hooks_auto_accept", True)

    # Append-only textual patch when possible (preserves comments/formatting
    # for the rest of the file); fall back to a full YAML rewrite only when
    # the file had no existing hooks: block to append after.
    if "\nhooks:" not in raw and not raw.startswith("hooks:"):
        block = (
            "\nhooks:\n"
            f"  kanban_task_blocked:\n    - command: {BRIDGE_CMD}\n"
            f"  on_kanban_task_updated:\n    - command: {BRIDGE_CMD}\n"
            "hooks_auto_accept: true\n"
        )
        config_path.write_text(raw.rstrip("\n") + "\n" + block, encoding="utf-8")
    else:
        # Already has a hooks: block missing one of the two events — safest
        # correct edit is a full re-dump via yaml (comments in the hooks
        # block, if any, are lost; acceptable for config, not skill content).
        config_path.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")

    return "patched"


def main() -> int:
    if not PROFILES_ROOT.exists():
        print("No profiles directory found; nothing to sync.")
        return 0

    results = {"patched": [], "skipped": [], "ok": []}
    for profile_dir in sorted(PROFILES_ROOT.iterdir()):
        if not profile_dir.is_dir():
            continue
        outcome = sync_profile(profile_dir)
        results[outcome].append(profile_dir.name)

    if results["patched"]:
        print(f"Patched kanban escalation hooks into {len(results['patched'])} profile(s): "
              f"{', '.join(results['patched'])}")
    if results["ok"]:
        print(f"Already had hooks: {', '.join(results['ok'])}")
    if results["skipped"]:
        print(f"Skipped (no identity / symlinked config / unreadable): {', '.join(results['skipped'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
