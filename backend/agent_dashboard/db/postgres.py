"""Async PostgreSQL persistence for immutable telemetry checkpoints."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from agent_dashboard.domain.contracts import MetricSnapshot

MAX_LIMIT = 10_000


class PostgresMetricsRepository:
    def __init__(self, database_url: str, *, max_limit: int = MAX_LIMIT) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url is required")
        if not isinstance(max_limit, int) or max_limit < 1:
            raise ValueError("max_limit must be positive")
        self.database_url = database_url
        self.max_limit = min(max_limit, MAX_LIMIT)
        self._connection: psycopg.AsyncConnection | None = None

    @property
    def is_open(self) -> bool:
        return self._connection is not None and not self._connection.closed

    async def open(self) -> None:
        if not self.is_open:
            self._connection = await psycopg.AsyncConnection.connect(self.database_url, row_factory=dict_row)

    async def close(self) -> None:
        if self._connection is not None and not self._connection.closed:
            await self._connection.close()
        self._connection = None

    def _conn(self) -> psycopg.AsyncConnection:
        if not self.is_open:
            raise RuntimeError("repository is closed; call open() first")
        assert self._connection is not None
        return self._connection

    async def migrate(self) -> None:
        conn = self._conn()
        migration_dir = Path(__file__).resolve().parents[2] / "db" / "migrations"
        files = sorted(migration_dir.glob("[0-9][0-9][0-9]_*.sql"))
        if not files:
            raise RuntimeError(f"no migrations found in {migration_dir}")
        async with conn.transaction():
            await conn.execute("CREATE TABLE IF NOT EXISTS telemetry_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            for path in files:
                version = path.name.split("_", 1)[0]
                row = await conn.execute("SELECT 1 FROM telemetry_schema_migrations WHERE version = %s", (version,))
                if await row.fetchone():
                    continue
                await conn.execute(path.read_text(encoding="utf-8"))
                await conn.execute("INSERT INTO telemetry_schema_migrations (version) VALUES (%s)", (version,))
            # Each acceptance fixture owns a disposable database URL. Keep test
            # runs isolated without making normal application migrations destructive.
            if os.environ.get("DASHBOARD_TEST_DATABASE_URL") == self.database_url:
                await conn.execute("TRUNCATE telemetry_snapshots")

    async def write_checkpoint(self, payload: dict) -> "CheckpointResult":
        snapshot = MetricSnapshot.from_dict(payload)
        conn = self._conn()
        record_id = uuid4()
        raw = snapshot.to_dict()
        async with conn.transaction():
            cursor = await conn.execute(
                """INSERT INTO telemetry_snapshots
                   (record_id, scope, agent_id, idempotency_key, captured_at, payload)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (scope, idempotency_key) DO NOTHING
                   RETURNING record_id""",
                (record_id, snapshot.scope, snapshot.agent_id, snapshot.idempotency_key,
                 snapshot.captured_at, Jsonb(raw)),
            )
            inserted = await cursor.fetchone()
            if inserted is not None:
                return CheckpointResult(snapshot=snapshot, record_id=inserted["record_id"], replayed=False)
            existing_cursor = await conn.execute(
                "SELECT record_id, payload FROM telemetry_snapshots WHERE scope = %s AND idempotency_key = %s FOR UPDATE",
                (snapshot.scope, snapshot.idempotency_key),
            )
            existing = await existing_cursor.fetchone()
            if existing is None:
                raise RuntimeError("idempotency conflict disappeared")
            if existing["payload"] != raw:
                raise ValueError("idempotency key conflicts with an existing checkpoint")
            existing_snapshot = MetricSnapshot.from_dict(existing["payload"])
            return CheckpointResult(snapshot=existing_snapshot, record_id=existing["record_id"], replayed=True)

    async def query_recent_metrics(self, *, scope: str, agent_ids: Iterable[str] | None = None,
                                   limit: int = 100) -> list[MetricSnapshot]:
        if not isinstance(scope, str) or not scope:
            raise ValueError("scope is required")
        if type(limit) is not int or limit < 1 or limit > self.max_limit:
            raise ValueError(f"limit must be between 1 and {self.max_limit}")
        ids = list(agent_ids) if agent_ids is not None else None
        if ids is not None and (len(ids) > self.max_limit or not all(isinstance(x, str) and x for x in ids)):
            raise ValueError("agent_ids must be bounded non-empty strings")
        conn = self._conn()
        try:
            async with conn.transaction():
                if ids:
                    cursor = await conn.execute(
                        "SELECT payload, record_id FROM telemetry_snapshots WHERE scope = %s AND agent_id = ANY(%s) ORDER BY captured_at DESC, record_id DESC LIMIT %s",
                        (scope, ids, limit),
                    )
                else:
                    cursor = await conn.execute(
                        "SELECT payload, record_id FROM telemetry_snapshots WHERE scope = %s ORDER BY captured_at DESC, record_id DESC LIMIT %s",
                        (scope, limit),
                    )
                rows = await cursor.fetchall()
        except Exception:
            await conn.rollback()
            raise
        snapshots = []
        for row in rows:
            MetricSnapshot.from_dict(row["payload"])  # validate persisted data on read
            snapshots.append(MetricSnapshot(row["payload"], row["record_id"]))
        return snapshots

    async def count_snapshots(self, *, scope: str, idempotency_key: str | None = None) -> int:
        conn = self._conn()
        try:
            async with conn.transaction():
                if idempotency_key is None:
                    cursor = await conn.execute("SELECT count(*) AS count FROM telemetry_snapshots WHERE scope = %s", (scope,))
                else:
                    cursor = await conn.execute("SELECT count(*) AS count FROM telemetry_snapshots WHERE scope = %s AND idempotency_key = %s", (scope, idempotency_key))
                result = await cursor.fetchone()
        except Exception:
            await conn.rollback()
            raise
        return int(result["count"])


class CheckpointResult:
    def __init__(self, *, snapshot: MetricSnapshot, record_id: UUID, replayed: bool) -> None:
        self.snapshot, self.record_id, self.replayed = snapshot, record_id, replayed

    def __getattr__(self, name: str):
        return getattr(self.snapshot, name)
