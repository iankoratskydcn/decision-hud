# Agent Dashboard Interface — Decision Record

Status: approved for implementation on branch `feat/agent-dashboard-interface`.

## Owner decisions

- Target: additive interface in the existing Decision HUD desktop plugin repository.
- Branch: `feat/agent-dashboard-interface`.
- Decision authority: existing Decision HUD SQLite store remains authoritative for decisions, approvals, resolution, defer/necessity state, reports, actor-token artifacts, and dispatch gates.
- Telemetry authority: PostgreSQL, accessed through a backend service owned inside this repository under `backend/`, with disposable Docker Compose integration tests.
- Desktop transport: plugin-owned `ctx.rest` to the backend; plugin does not access filesystem/database directly.
- Identity: reuse existing Decision HUD actor tokens for telemetry reads and future control authorization, extended with explicit project claims. No anonymous fallback.
- Scope: selected project and its agents only; cross-project reads require explicit scope.
- V1: read-only dashboard and telemetry interface. All control levers are cataloged/design-scoped but not executable until each has an authenticated command/acknowledgment/CAS/expiry contract.
- V1 metrics: all metric categories may be represented in the registry, but only metrics with defined source/formula/freshness/units and tests may be displayed as live. Undefined metrics must be labeled unavailable, never fabricated.
- Delivery: local commits only; no push and no merge.

## Implementation boundaries

- No second approval/dispatch store.
- No direct `Lever.apply()` live-agent mutation.
- No chat implementation until an authenticated Hermes session/transport contract is separately approved.
- No prediction, Pareto, ML, or autonomous control claims in v1.
- Existing pane registration and card-renderer behavior must remain regression-safe; dashboard must be one additional stateful pane or an explicitly approved bounded section, never a duplicate live route tree.
