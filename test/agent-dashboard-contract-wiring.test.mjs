import assert from 'node:assert/strict'
import { collectRegistrations } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'

installLocalStorageStub()

const DASHBOARD_PANE_ID = 'decision-hud:agent-dashboard'
const SCOPE_STORAGE_KEY = 'decision-hud:agent-dashboard-scope'

function findPane(registrations, id) {
  return registrations.find((r) => r.area === 'panes' && r.id === id)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

async function collectWithRest(rest) {
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
  const { default: plugin } = await import('../plugin.js')
  plugin.register(ctx)
  return registrations
}

// --- Contract: project_id query param + Authorization bearer header -------
localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ projectId: 'project-alpha', token: 'actor-token-123' }))

const validSnapshot = {
  schema_version: 'dashboard-read-model.v1',
  scope: { project_id: 'project-alpha', project_label: 'Project Alpha' },
  freshness: { state: 'fresh', as_of: '2026-09-12T20:00:00Z' },
  agents: [],
  metrics: [],
  pending_decisions: [],
}

{
  const requests = []
  const regs = await collectWithRest(async (path, options) => {
    requests.push({ path, options })
    return validSnapshot
  })
  const pane = findPane(regs, DASHBOARD_PANE_ID)
  const mounted = mount(pane.render)
  await flush()

  assert.equal(requests.length, 1, 'exactly one read-model request must be made')
  const [{ options }] = requests
  assert.equal(options?.query?.project_id, 'project-alpha', 'request must send project_id as a query param')
  const headers = options?.headers || {}
  const authHeader = headers.Authorization || headers.authorization
  assert.equal(authHeader, 'Bearer actor-token-123', 'request must send Authorization: Bearer <token> header')

  await mounted.unmount()
}

// --- Contract: freshness.state === 'missing' is an explicit empty state, ---
// --- not a thrown exception / generic error --------------------------------
{
  const missingSnapshot = {
    ...validSnapshot,
    freshness: { state: 'missing', as_of: null },
  }
  const regs = await collectWithRest(async () => missingSnapshot)
  const pane = findPane(regs, DASHBOARD_PANE_ID)
  const mounted = mount(pane.render)
  await flush()

  assert.equal(mounted.errors.length, 0, 'missing-state snapshot must not crash the dashboard render')
  const rendered = text(mounted.container)
  assert.match(rendered, /no data|missing|empty|unavailable/i, 'missing freshness state must be surfaced as an explicit empty state')
  assert.doesNotMatch(rendered, /Dashboard unavailable/i, 'missing freshness must not be reported as a generic fetch error')

  await mounted.unmount()
}

console.log('agent-dashboard-contract-wiring test reached')
