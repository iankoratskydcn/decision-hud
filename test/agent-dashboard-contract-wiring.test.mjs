import assert from 'node:assert/strict'
import { collectRegistrations } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const DASHBOARD_PANE_ID = 'decision-hud:agent-dashboard'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

// Board-scoped auth (2026-09-14 owner decision, supersedes the old
// decision-hud:agent-dashboard-scope localStorage placeholder this file
// used to exercise): project_id + actor token now come from the
// currently-selected Kanban board via useProjectDashboardScope() in
// plugin.js. Same stub as agent-dashboard-interface.test.mjs.
function installKanbanScopeStub({ boardSlug, projectId, token, tokenError }) {
  if (boardSlug) localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardSlug)
  const originalRequest = host.request
  host.request = async (method, params) => {
    if (method !== 'cli.exec') return originalRequest(method, params)
    const argv = params?.argv || []
    if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
      const boards = boardSlug ? [{ slug: boardSlug, project_id: projectId || null }] : []
      return { code: 0, output: JSON.stringify(boards) }
    }
    if (argv[0] === 'decision' && argv[1] === 'issue-token') {
      if (tokenError) return { code: 0, output: JSON.stringify({ ok: false, error: tokenError }) }
      return { code: 0, output: JSON.stringify({ ok: true, actor_token: token, project_id: projectId }) }
    }
    return originalRequest(method, params)
  }
  return () => { host.request = originalRequest }
}

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
const uninstallScope = installKanbanScopeStub({ boardSlug: 'default', projectId: 'project-alpha', token: 'actor-token-123' })

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
  assert.equal(authHeader, 'Bearer actor-token-123', 'request must send Authorization: Bearer *** header')

  await mounted.unmount()
}

uninstallScope()

// --- Contract: freshness.state === 'missing' is an explicit empty state, ---
// --- not a thrown exception / generic error --------------------------------
{
  const uninstall = installKanbanScopeStub({ boardSlug: 'default', projectId: 'project-alpha', token: 'actor-token-123' })
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
  uninstall()
}

console.log('agent-dashboard-contract-wiring test reached')
