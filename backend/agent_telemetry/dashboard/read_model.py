"""Bounded dashboard projection over selected-scope telemetry."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from agent_telemetry.db.postgres import MAX_LIMIT


@dataclass(frozen=True)
class Freshness:
    state: str
    observed_at: datetime | None


@dataclass(frozen=True)
class AgentStatus:
    agent_id: str
    freshness: Freshness
    metrics: dict[str, Any]


#: Public plugin contract emitted by ``DashboardStatus.to_dict()``. Internal
#: per-agent freshness/raw values are preserved on the dataclass (see
#: ``AgentStatus``/``Freshness``) for callers that need them; ``to_dict()``
#: projects that internal shape into the exact top-level plugin contract.
PLUGIN_SCHEMA_VERSION = "dashboard-read-model.v1"


@dataclass(frozen=True)
class DashboardStatus:
    schema_version: str
    scope: str
    agents: list[AgentStatus]

    def to_dict(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)

        # Top-level freshness reflects whether any telemetry data was
        # retrieved for the requested agents (data-presence), independent of
        # the per-agent staleness threshold, which is preserved internally on
        # each ``AgentStatus.freshness`` for finer-grained consumers.
        latest_observed: datetime | None = None
        any_present = False
        for agent in self.agents:
            if agent.freshness.state != "missing":
                any_present = True
            if agent.freshness.observed_at is not None and (
                latest_observed is None or agent.freshness.observed_at > latest_observed
            ):
                latest_observed = agent.freshness.observed_at
        overall_state = "fresh" if any_present else "missing"
        as_of = (latest_observed or now).isoformat()

        agents_out = [
            {
                "agent_id": agent.agent_id,
                "label": agent.agent_id,
                "status": "missing" if agent.freshness.state == "missing" else "running",
            }
            for agent in self.agents
        ]

        metrics_out: list[dict[str, Any]] = []
        for agent in self.agents:
            for key, value in agent.metrics.items():
                raw_value = value.raw_value if hasattr(value, "raw_value") else value
                unit = getattr(value, "unit", None)
                # category is optional on the wire (older/synthetic values may
                # omit it); consumers that group by category must treat a
                # missing category as its own explicit bucket, never guess one.
                category = getattr(value, "category", None)
                metrics_out.append(
                    {
                        "key": key,
                        "label": key,
                        "value": raw_value,
                        "unit": unit,
                        "category": category,
                        "agent_id": agent.agent_id,
                        "source_window": "telemetry",
                        "freshness": "missing" if agent.freshness.state == "missing" else "fresh",
                    }
                )

        return {
            "schema_version": PLUGIN_SCHEMA_VERSION,
            "scope": {"project_id": self.scope, "project_label": self.scope},
            "freshness": {"state": overall_state, "as_of": as_of},
            "agents": agents_out,
            "metrics": metrics_out,
        }


class DashboardReadModel:
    def __init__(self, repository: Any, *, freshness_threshold: timedelta = timedelta(minutes=5), max_limit: int = MAX_LIMIT) -> None:
        if freshness_threshold.total_seconds() < 0:
            raise ValueError("freshness_threshold must not be negative")
        if type(max_limit) is not int or not 1 <= max_limit <= MAX_LIMIT:
            raise ValueError("max_limit is out of bounds")
        self.repository = repository
        self.freshness_threshold = freshness_threshold
        self.max_limit = max_limit

    @staticmethod
    def live_snapshot(kanban_db_path: str | None = None, state_db_path: str | None = None) -> dict[str, Any]:
        """Second, explicitly-labeled data path: Agent Matrix's live local

        SQLite source (same data `hermes decision agent-metrics-snapshot`
        serves), reusing ``scripts/agent_metrics_snapshot.py`` verbatim — no
        second HTTP surface, no re-implementation. Its
        ``schema_version`` (``agent-metrics-snapshot.v1``) is always distinct
        from ``status()``'s Postgres-backed ``dashboard-read-model.v1``, so
        callers can tag/join the two sources but must never blend them into
        one number (see the Wave 1a owner decision on authority boundaries).
        """
        from scripts.agent_metrics_snapshot import DEFAULT_KANBAN_DB, DEFAULT_STATE_DB, build_snapshot

        kanban_db_path = kanban_db_path or DEFAULT_KANBAN_DB
        state_db_path = state_db_path or DEFAULT_STATE_DB
        if not Path(state_db_path).exists():
            state_db_path = None
        return build_snapshot(kanban_db_path=kanban_db_path, state_db_path=state_db_path)

    async def status(self, *, scope: str, agent_ids: Iterable[str], limit: int = 100) -> DashboardStatus:
        if type(limit) is not int or limit < 1 or limit > self.max_limit:
            raise ValueError(f"limit must be between 1 and {self.max_limit}")
        ids = list(agent_ids)
        if len(ids) > limit or len(ids) > self.max_limit or not all(isinstance(x, str) and x for x in ids):
            raise ValueError("agent_ids must be bounded non-empty strings and fit limit")
        rows = await self.repository.query_recent_metrics(scope=scope, agent_ids=ids, limit=min(self.max_limit, max(limit * max(len(ids), 1), limit)))
        latest = {}
        for row in rows:
            latest.setdefault(row.agent_id, row)
        now = datetime.now(timezone.utc)
        agents = []
        for agent_id in ids[:limit]:
            row = latest.get(agent_id)
            if row is None:
                freshness = Freshness("missing", None)
                metrics = {}
            else:
                observed = datetime.fromisoformat(row.captured_at.replace("Z", "+00:00"))
                if observed.tzinfo is None:
                    observed = observed.replace(tzinfo=timezone.utc)
                freshness = Freshness("fresh" if now - observed <= self.freshness_threshold else "stale", observed)
                metrics = row.values
            agents.append(AgentStatus(agent_id, freshness, metrics))
        return DashboardStatus("dashboard.read-model.v1", scope, agents)
