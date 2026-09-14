import assert from 'node:assert/strict'
import { collectRegistrations as collectRendered, renderRegistration } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'

installLocalStorageStub()

const ROUTE_PATH = '/decision-hud/agent-metrics'

function collectWithRest(rest) {
  const registrations = []
  const ctx = {
    rest,
    host: { navigate() {}, revealPane() {} },
    register(registration) {
      registrations.push(registration)
      return () => {}
    },
    registerMany(items) {
      registrations.push(...items)
    },
  }
  return import('../plugin.js').then(({ default: plugin }) => {
    plugin.register(ctx)
    return registrations
  })
}

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function findNav(registrations, path) {
  return registrations.find((r) => r.area === 'sidebar.nav' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

// Baseline: the route/nav contributions must exist, additively, alongside
// the existing Decision HUD and Agent Dashboard registrations.
const registrations = collectRendered()
const route = findRoute(registrations, ROUTE_PATH)
assert.ok(route, `expected a ${ROUTE_PATH} route registration`)
const nav = findNav(registrations, ROUTE_PATH)
assert.ok(nav, `expected a sidebar nav entry for ${ROUTE_PATH}`)
assert.equal(nav.data.label, 'Agent Metrics')

const existingDecisionRoute = findRoute(registrations, '/decision-hud')
assert.ok(existingDecisionRoute, 'existing Decision HUD route must remain')
const existingDashboardRoute = findRoute(registrations, '/decision-hud/agent-dashboard')
assert.ok(existingDashboardRoute, 'existing Agent Dashboard route must remain')

const validSnapshot = {
  schema_version: 'dashboard-read-model.v1',
  scope: { project_id: 'project-alpha', project_label: 'Project Alpha' },
  freshness: { state: 'fresh', as_of: '2026-09-12T20:00:00Z' },
  agents: [{ agent_id: 'agent-1', label: 'Builder', status: 'running' }],
  metrics: [
    { key: 'token_burn_rate', label: 'token_burn_rate', value: 12.5, unit: 'tokens/min', category: 'resource', source_window: 'telemetry', freshness: 'fresh' },
    { key: 'throughput', label: 'throughput', value: 4, unit: 'tasks/hour', category: 'throughput_progress', source_window: 'telemetry', freshness: 'fresh' },
    { key: 'legacy_metric', label: 'legacy_metric', value: 1, unit: null, source_window: 'telemetry', freshness: 'fresh' },
  ],
}

async function mountPage(response) {
  const requests = []
  const regs = await collectWithRest(async (path, options) => {
    requests.push({ path, options })
    if (response instanceof Error) throw response
    return response
  })
  const route = findRoute(regs, ROUTE_PATH)
  assert.ok(route, 'agent-metrics route must be available to mount')
  const mounted = mount(route.render)
  await flush()
  return { ...mounted, requests }
}

// Live state: metrics grouped by category, with an explicit uncategorized
// bucket for metrics missing a category (never dropped, never guessed).
{
  const mounted = await mountPage(validSnapshot)
  const rendered = text(mounted.container)
  assert.match(rendered, /Resource/i)
  assert.match(rendered, /Throughput/i)
  assert.match(rendered, /Uncategorized/i)
  assert.match(rendered, /token_burn_rate/i)
  assert.match(rendered, /legacy_metric/i)
  assert.equal(mounted.errors.length, 0)
  assert.equal(mounted.requests.length, 1, 'must reuse one bounded read-model request, same contract as the docked pane')
  assert.match(String(mounted.requests[0].path), /dashboard|telemetry|read-model|agent-dashboard/i)
  await mounted.unmount()
}

// Loading state.
{
  const mounted = await mountPage(new Promise(() => {}))
  assert.match(text(mounted.container), /loading/i)
  await mounted.unmount()
}

// Error state: no fabricated data on failure.
{
  const mounted = await mountPage(new Error('telemetry unavailable'))
  assert.match(text(mounted.container), /unavailable|error/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

console.log('agent-metrics-fullpage acceptance tests reached')
