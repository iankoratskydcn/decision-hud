// TDD for the agent_metrics_snapshot.py-backed widget set (heatmap, scatter,
// parallel coordinates, treemap, radar, sankey) — a genuinely separate
// surface from AgentMetricsPage (which reads the Postgres-backed
// DASHBOARD_READ_MODEL_PATH read model). This page drives
// `hermes decision agent-metrics-snapshot` via cli.exec, same as every
// other plugin.js data call — no rest()/REST route involved.
import assert from 'node:assert/strict'
import { collectRegistrations, mount, flush } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

const ROUTE_PATH = '/decision-hud/agent-metrics/snapshot'

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

function installCliExecStub(responder) {
  const originalRequest = host.request
  host.request = async (method, params) => {
    if (method !== 'cli.exec') return originalRequest(method, params)
    const argv = params?.argv || []
    if (argv[0] === 'decision' && argv[1] === 'agent-metrics-snapshot') {
      return responder(argv)
    }
    return originalRequest(method, params)
  }
  return () => { host.request = originalRequest }
}

async function mountPage(responder) {
  const uninstall = installCliExecStub(responder)
  const registrations = collectRegistrations()
  const route = findRoute(registrations, ROUTE_PATH)
  assert.ok(route, `expected a ${ROUTE_PATH} route registration`)
  const mounted = mount(route.render)
  await flush()
  return { ...mounted, unmount: async () => { await mounted.unmount(); uninstall() } }
}

const sampleSnapshot = {
  schema_version: 'agent-metrics-snapshot.v1',
  updated_at: 1789639572,
  source: { kanban_db: '/x/kanban.db', state_db: '/x/state.db' },
  records: [
    { assignee: 'builder', outcome: 'completed', volume: 10, avg_duration_s: 300, cost_status: 'unavailable', cost_usd: null },
    { assignee: 'builder', outcome: 'blocked', volume: 2, avg_duration_s: 120, cost_status: 'unavailable', cost_usd: null },
    { assignee: 'builder', outcome: 'crashed', volume: 1, avg_duration_s: 10, cost_status: 'unavailable', cost_usd: null },
    { assignee: 'reviewer', outcome: 'completed', volume: 5, avg_duration_s: 200, cost_status: 'complete', cost_usd: 1.5 },
  ],
  handoffs: [
    { from: 'builder', to: 'reviewer', volume: 8 },
    { from: 'reviewer', to: 'builder', volume: 1 },
  ],
}

// Baseline: the route exists additively, alongside the existing
// /decision-hud/agent-metrics (Postgres-backed) route — this task must not
// touch that route or DASHBOARD_READ_MODEL_PATH.
{
  const registrations = collectRegistrations()
  assert.ok(findRoute(registrations, ROUTE_PATH), 'agent-metrics-snapshot widgets route must exist')
  assert.ok(findRoute(registrations, '/decision-hud/agent-metrics'), 'existing Postgres-backed AgentMetricsPage route must be untouched')
}

// Live-shaped snapshot renders all six widgets with real-looking markers,
// via exactly one cli.exec call to `decision agent-metrics-snapshot`.
{
  const calls = []
  const mounted = await mountPage((argv) => { calls.push(argv); return { code: 0, output: JSON.stringify(sampleSnapshot) } })
  const rendered = text(mounted.container)
  assert.equal(mounted.errors.length, 0)
  assert.equal(calls.length, 1)
  assert.match(rendered, /heatmap/i)
  assert.match(rendered, /scatter/i)
  assert.match(rendered, /parallel/i)
  assert.match(rendered, /treemap/i)
  assert.match(rendered, /radar/i)
  assert.match(rendered, /sankey|handoff/i)
  assert.match(rendered, /builder/i)
  assert.match(rendered, /reviewer/i)
  // heatmap cells must be real DOM nodes, not just text
  assert.ok(mounted.container.querySelectorAll('[data-heatmap-cell]').length > 0)
  // scatter/radar/treemap/sankey/parallel must render SVG content
  assert.ok(mounted.container.querySelector('[data-widget="scatter"] svg'))
  assert.ok(mounted.container.querySelector('[data-widget="radar"] svg'))
  assert.ok(mounted.container.querySelector('[data-widget="treemap"] svg'))
  assert.ok(mounted.container.querySelector('[data-widget="sankey"] svg'))
  assert.ok(mounted.container.querySelector('[data-widget="parallel-coordinates"] svg'))
  await mounted.unmount()
}

// Empty snapshot (no records, no handoffs): explicit unavailable state per
// widget, never fabricated data — this repo's no-mock-data discipline.
{
  const empty = { ...sampleSnapshot, records: [], handoffs: [] }
  const mounted = await mountPage(() => ({ code: 0, output: JSON.stringify(empty) }))
  const rendered = text(mounted.container)
  assert.match(rendered, /no agent metrics|unavailable/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

// Records present but handoffs empty: sankey specifically must show its own
// unavailable state while the other five widgets still render real data —
// no widget should ever borrow another widget's data to fill a gap.
{
  const noHandoffs = { ...sampleSnapshot, handoffs: [] }
  const mounted = await mountPage(() => ({ code: 0, output: JSON.stringify(noHandoffs) }))
  const sankeyText = text(mounted.container.querySelector('[data-widget="sankey"]'))
  assert.match(sankeyText, /no handoffs|unavailable/i)
  assert.ok(mounted.container.querySelector('[data-widget="scatter"] svg'), 'other widgets must still render with data present')
  await mounted.unmount()
}

// cli.exec failure (nonzero exit / blocked): explicit error state, no
// fabricated snapshot.
{
  const mounted = await mountPage(() => ({ code: 1, output: 'boom' }))
  assert.match(text(mounted.container), /unavailable|error/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

console.log('agent-metrics-widgets acceptance tests reached')
