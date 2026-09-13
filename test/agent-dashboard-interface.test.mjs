import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderRegistration, collectRegistrations as collectRendered } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'

installLocalStorageStub()

const DASHBOARD_PANE_ID = 'decision-hud:agent-dashboard'
const DASHBOARD_PATH = '/decision-hud/agent-dashboard'

function collectWithRest(rest) {
  const registrations = []
  const ctx = {
    rest,
    register(registration) {
      registrations.push(registration)
      return () => {}
    },
    registerMany(items) {
      registrations.push(...items)
    },
  }
  // Importing the default through the render harness keeps the production
  // registration entry point under test; this helper only adds the sanctioned
  // ctx.rest seam needed to exercise the dashboard's read-only projection.
  return import('../plugin.js').then(({ default: plugin }) => {
    plugin.register(ctx)
    return registrations
  })
}

function findPane(registrations, id) {
  return registrations.find((r) => r.area === 'panes' && r.id === id)
}

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

// Registration and route are deliberately checked through captured runtime
// contributions, not by searching plugin.js text. The first assertion is the
// strict RED gate on the baseline: no dashboard contribution exists yet.
const registrations = collectRendered()
const existingSource = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')
const dashboardPane = findPane(registrations, DASHBOARD_PANE_ID)
assert.ok(dashboardPane, `expected one additive ${DASHBOARD_PANE_ID} panes registration`)
assert.equal(dashboardPane.title, 'Agent Dashboard')
assert.deepEqual(dashboardPane.data?.dock, { pane: 'workspace', pos: 'right' })
assert.match(String(dashboardPane.data?.minWidth), /^(?:\d+(?:\.\d+)?rem|\d+px)$/)

const dashboardRoute = findRoute(registrations, DASHBOARD_PATH)
assert.ok(dashboardRoute, `expected a static dashboard route at ${DASHBOARD_PATH}`)
const routeRender = renderRegistration(dashboardRoute)
assert.equal(routeRender.error, null, 'dashboard route must render without throwing')
assert.match(routeRender.html, /Agent Dashboard/i)
assert.match(routeRender.html, /Show Agent Dashboard/i)
assert.doesNotMatch(routeRender.html, /<input|<select|aria-label="Settings"/i, 'route fallback must not mount a second live dashboard tree')

// Preserve the existing Decision HUD registration and route fallback while the
// additive dashboard is introduced.
const decisionPane = findPane(registrations, 'decision-hud:pane')
assert.ok(decisionPane, 'existing Decision HUD pane registration must remain')
assert.deepEqual(decisionPane.data?.dock, { pane: 'workspace', pos: 'right' })
const decisionRoute = findRoute(registrations, '/decision-hud')
assert.ok(decisionRoute, 'existing Decision HUD route must remain')
const decisionRouteRender = renderRegistration(decisionRoute)
assert.equal(decisionRouteRender.error, null)
assert.match(decisionRouteRender.html, /Decision HUD lives in the docked pane/i)
assert.match(decisionRouteRender.html, /Show Decision HUD/i)

// Render the existing stateful pane as a real component too. This guards the
// protected surface from a dashboard integration that accidentally replaces it.
const decisionRendered = renderRegistration(decisionPane)
assert.equal(decisionRendered.error, null, 'existing Decision HUD pane must still SSR-render')
assert.match(decisionRendered.html, /Decision HUD/i)

// The existing card contract is intentionally a source-level seam check only
// because plugin.js does not export DecisionCard and the stateful pane's SSR
// first render has no fetched decision rows. Runtime registration rendering
// above still proves the existing pane is mountable; these two assertions
// protect the exact fallback dispatch that must not be altered by integration.
assert.match(existingSource, /function DefaultChoiceCard\(\{ decision, onResolve, resolving \}\)/)
assert.match(existingSource, /const Body = CARD_RENDERERS\[decision\.card_type\] \|\| DefaultChoiceCard/)

const validSnapshot = {
  schema_version: 'dashboard-read-model.v1',
  scope: { project_id: 'project-alpha', project_label: 'Project Alpha' },
  freshness: { state: 'fresh', as_of: '2026-09-12T20:00:00Z' },
  agents: [{ agent_id: 'agent-1', label: 'Builder', status: 'running', blocked: 2, running: 1 }],
  metrics: [{ key: 'throughput', label: 'Throughput', value: 12, unit: 'tasks/hour', source_window: 'last 20m', freshness: 'fresh' }],
  pending_decisions: [],
}

async function mountDashboard(response) {
  const requests = []
  const regs = await collectWithRest(async (path, options) => {
    requests.push({ path, options })
    if (response instanceof Error) throw response
    return response
  })
  const pane = findPane(regs, DASHBOARD_PANE_ID)
  assert.ok(pane, 'dashboard pane must be available to mount')
  const mounted = mount(pane.render)
  await flush()
  return { ...mounted, requests }
}

// The read model must expose all user-visible async states without inventing
// values. A single live tree is mounted per case and always unmounted.
for (const [name, response, expected] of [
  ['loading', new Promise(() => {}), /loading/i],
  ['live', validSnapshot, /Project Alpha.*Throughput.*12.*tasks\/hour.*last 20m/i],
  ['error', new Error('telemetry unavailable'), /error|unavailable|retry/i],
  ['stale', { ...validSnapshot, freshness: { state: 'stale', age_seconds: 125, as_of: '2026-09-12T17:58:00Z' } }, /stale/i],
  ['unavailable', { ...validSnapshot, metrics: [{ key: 'throughput', label: 'Throughput', state: 'unavailable', reason: 'insufficient samples' }] }, /unavailable|n\/a|insufficient/i],
]) {
  const mounted = await mountDashboard(response)
  const renderedText = text(mounted.container)
  assert.match(renderedText, expected, `${name} state must be identified in the dashboard UI`)
  assert.equal(mounted.errors.length, 0, `${name} state must not crash the dashboard render`)
  if (name === 'live') {
    assert.match(renderedText, /Scope|Project Alpha/i)
    assert.match(renderedText, /Agent|Builder/i)
    assert.doesNotMatch(renderedText, /Resolve|Defer|Apply|Run|Stop|Send/i, 'v1 dashboard projection must remain read-only')
    assert.equal(mounted.requests.length, 1, 'dashboard refresh must use one bounded read-model request')
    assert.match(String(mounted.requests[0].path), /dashboard|telemetry|read-model/i)
  }
  await mounted.unmount()
}

// A valid response with too many rows must be bounded and disclose omission;
// this is an acceptance guard against an unbounded DOM/focus sequence.
const bounded = {
  ...validSnapshot,
  agents: Array.from({ length: 10001 }, (_, i) => ({ agent_id: `agent-${i}`, label: `Agent ${i}`, status: 'idle' })),
}
const boundedMount = await mountDashboard(bounded)
assert.ok(boundedMount.container.querySelectorAll('[data-agent-row], [role="listitem"]').length <= 1000, 'agent rows must be capped/windowed')
assert.match(text(boundedMount.container), /10000|omitted|showing|limited|cap/i)
await boundedMount.unmount()

// Unknown/malformed metric values may not become plausible live values.
const malformedMount = await mountDashboard({ ...validSnapshot, metrics: [{ key: 'quality', label: 'Quality', value: Infinity, unit: '%' }] })
assert.match(text(malformedMount.container), /unavailable|n\/a|invalid|no data/i)
assert.doesNotMatch(text(malformedMount.container), /Infinity/i)
await malformedMount.unmount()

console.log('agent-dashboard-interface acceptance tests reached')
