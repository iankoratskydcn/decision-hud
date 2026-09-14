CREATE TABLE IF NOT EXISTS telemetry_schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry_snapshots (
    record_id uuid PRIMARY KEY,
    scope text NOT NULL,
    agent_id text NOT NULL,
    idempotency_key text NOT NULL,
    captured_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS telemetry_snapshots_scope_agent_captured_idx
    ON telemetry_snapshots (scope, agent_id, captured_at DESC, record_id DESC);
