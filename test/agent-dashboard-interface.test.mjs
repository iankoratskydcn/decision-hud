import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderRegistration, collectRegistrations as collectRendered } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const DASHBOARD_PANE_ID = 'decision-hud:agent-dashboard'
const DASHBOARD_PATH = '/decision-hud/agent-dashboard'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

// Board-scoped auth (2026-09-14 owner decision): the dashboard's project_id
// + actor token now come from the currently-selected Kanban board, not a
// placeholder scope key — see useProjectDashboardScope() in plugin.js. This
// stub answers the two `cliExec` calls that path makes: `kanban boards list
// --json` (resolves the selected slug to a project_id) and `decision
// issue-token --actor desktop-pane --project-id <id>` (mints the token).
// `host` is the SAME mutable singleton plugin.js's cliExec calls
// `host.request` on, so patching it here reaches the real code path with no
// extra seam.
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
// Default placement is 'session-tab' now (2026-09 owner decision — see
// pinned-pane.test.mjs), which docks into the SESSIONS zone as a center
// tab, not the old right-of-workspace column.
assert.deepEqual(dashboardPane.data?.dock, { pane: 'sessions', pos: 'center', enforce: true })

// The old /decision-hud/agent-dashboard reveal-and-redirect placeholder
// route no longer exists — session-tab panes need no route at all.
assert.equal(findRoute(registrations, DASHBOARD_PATH), undefined, `${DASHBOARD_PATH} route must no longer exist`)

// Preserve the existing Decision HUD registration (route fallback is gone
// by design — see pinned-pane.test.mjs) while the additive dashboard is
// introduced.
const decisionPane = findPane(registrations, 'decision-hud:pane')
assert.ok(decisionPane, 'existing Decision HUD pane registration must remain')
assert.deepEqual(decisionPane.data?.dock, { pane: 'sessions', pos: 'center', enforce: true })
assert.equal(findRoute(registrations, '/decision-hud'), undefined, '/decision-hud route must no longer exist')

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

async function mountDashboard(response, scope = {}) {
  const uninstall = installKanbanScopeStub({
    boardSlug: 'default',
    projectId: 'project-alpha',
    token: 'actor-token-123',
    ...scope,
  })
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
  return { ...mounted, requests, unmount: async () => { await mounted.unmount(); uninstall() } }
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

// --- Board-scoped auth acceptance (2026-09-14 owner decision) -------------
// No board selected -> no project_id -> explicit prompt, never an unscoped
// or failing request (this pane never issues a request without a resolved
// project_id + token).
{
  const uninstall = installKanbanScopeStub({ boardSlug: null })
  const requests = []
  const regs = await collectWithRest(async (path, options) => { requests.push({ path, options }); return validSnapshot })
  const pane = findPane(regs, DASHBOARD_PANE_ID)
  const mounted = mount(pane.render)
  await flush()
  assert.equal(requests.length, 0, 'no board selected must never issue a read-model request')
  assert.match(text(mounted.container), /select a board/i, 'no board selected must surface an explicit prompt')
  await mounted.unmount()
  uninstall()
}

// A token-mint failure (e.g. `decision issue-token --project-id` erroring)
// must surface as an explicit error state, never a silent unscoped request.
{
  const uninstall = installKanbanScopeStub({ boardSlug: 'default', projectId: 'project-alpha', tokenError: 'backend unreachable' })
  const requests = []
  const regs = await collectWithRest(async (path, options) => { requests.push({ path, options }); return validSnapshot })
  const pane = findPane(regs, DASHBOARD_PANE_ID)
  const mounted = mount(pane.render)
  await flush()
  assert.equal(requests.length, 0, 'a token-mint failure must never fall back to an unscoped request')
  assert.match(text(mounted.container), /backend unreachable/i, 'token-mint failure must surface the underlying error')
  await mounted.unmount()
  uninstall()
}

console.log('agent-dashboard-interface acceptance tests reached')
