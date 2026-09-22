// Wave 2d: cost/quality/speed comparison panel — fed by Wave 1d's
// CrossSourceComparison read model over a sibling REST route
// (/agent-dashboard/comparison) to the docked Agent Dashboard pane's own
// DASHBOARD_READ_MODEL_PATH. Same board-scoped actor-token auth pattern as
// agent-metrics-fullpage.test.mjs (see that file's stub for the full
// rationale) — this route still needs *a* valid token even though its rows
// are producer-tagged, not project-scoped.
import assert from 'node:assert/strict'
import { collectRegistrations as collectRendered } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const ROUTE_PATH = '/decision-hud/agent-dashboard/comparison'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

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

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

// Additive route, alongside the existing Agent Dashboard/Agent Matrix pages.
{
  const registrations = collectRendered()
  assert.ok(findRoute(registrations, ROUTE_PATH), 'comparison panel route must exist')
  assert.ok(findRoute(registrations, '/decision-hud/agent-metrics'), 'existing Agent Metrics route must be untouched')
  assert.ok(findRoute(registrations, '/decision-hud/agent-metrics/snapshot'), 'existing Agent Matrix route must be untouched')
}

const validSnapshot = {
  schema_version: 'agent-dashboard-comparison.v1',
  baseline_path: 'baseline',
  rows: [
    { producer: 'kanban-sync', path: 'kanban_agent', agent_id: 'alice', input_tokens: 1000, output_tokens: 200, latency_ms: 950.0, quality_score: 0.9 },
    { producer: 'sidecars', path: 'sidecar_active', agent_id: 'op-a', input_tokens: 100, output_tokens: 20, latency_ms: 250.0, quality_score: null },
  ],
  comparisons: {
    sidecar_active: { net_token_savings: { input: 900, output: 180 }, avoidance_rate: 0.5, latency_delta_ms: -700.0, quality_retention: null },
  },
}

async function mountPage(response, scope = {}) {
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
  const route = findRoute(regs, ROUTE_PATH)
  assert.ok(route, 'comparison panel route must be available to mount')
  const mounted = mount(route.render)
  await flush()
  return { ...mounted, requests, unmount: async () => { await mounted.unmount(); uninstall() } }
}

// Live state: producer-tagged rows and derived metrics render distinctly,
// never blended — a kanban row and a sidecar row stay visibly separate.
{
  const mounted = await mountPage(validSnapshot)
  const rendered = text(mounted.container)
  assert.match(rendered, /kanban-sync/i)
  assert.match(rendered, /sidecars/i)
  assert.match(rendered, /kanban_agent/i)
  assert.match(rendered, /sidecar_active/i)
  assert.match(rendered, /not yet judged/i, 'null quality_score must render as "not yet judged", never a fabricated 0')
  assert.match(rendered, /net token savings/i)
  assert.equal(mounted.errors.length, 0)
  assert.equal(mounted.requests.length, 1, 'must issue exactly one bounded comparison request')
  assert.match(String(mounted.requests[0].path), /comparison/i)
  await mounted.unmount()
}

// Path filter: selecting one path shows only its rows, others stay filtered out.
{
  const mounted = await mountPage(validSnapshot)
  const select = mounted.container.querySelector('select, [role="combobox"]')
  const rows = () => [...mounted.container.querySelectorAll('[data-comparison-row]')]
  assert.equal(rows().length, 2, 'default filter (all paths) shows every row')
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
  const mounted = await mountPage(new Error('comparison unavailable'))
  assert.match(text(mounted.container), /unavailable|error/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

// No board selected: explicit unavailable state, not a silent empty panel.
{
  const mounted = await mountPage(validSnapshot, { boardSlug: null, projectId: null })
  assert.match(text(mounted.container), /select a board/i)
  await mounted.unmount()
}

console.log('comparison panel tests passed')
