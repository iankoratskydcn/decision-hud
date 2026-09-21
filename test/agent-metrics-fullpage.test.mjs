import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectRegistrations as collectRendered, renderRegistration } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const ROUTE_PATH = '/decision-hud/agent-metrics'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

// Board-scoped auth (2026-09-14 owner decision) — same stub as
// agent-dashboard-interface.test.mjs; see that file's comment for the full
// rationale. This page shares useProjectDashboardScope() with the docked
// Agent Dashboard pane, so it makes the identical two cliExec calls.
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

// The route is a first-class workspace surface, with sidebar navigation like
// Kanban. Decision HUD and Agent Matrix are also expected to be route-backed;
// Task List remains the separate docked operational queue.
const registrations = collectRendered()
const route = findRoute(registrations, ROUTE_PATH)
assert.ok(route, `expected a ${ROUTE_PATH} route registration`)
assert.ok(findRoute(registrations, '/decision-hud'), 'Decision HUD page route must exist')
assert.ok(findRoute(registrations, '/decision-hud/agent-metrics'), 'Agent Dashboard page route must exist')
assert.ok(findRoute(registrations, '/decision-hud/agent-metrics/snapshot'), 'Agent Matrix page route must exist')

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
  assert.ok(route, 'agent-metrics route must be available to mount')
  const mounted = mount(route.render)
  await flush()
  return { ...mounted, requests, unmount: async () => { await mounted.unmount(); uninstall() } }
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

// Stable category ordering: rendered card order must follow the fixed
// AGENT_METRICS_CATEGORY_LABELS key order for known categories, regardless
// of the arrival order of metrics[] from the backend (Map insertion order
// is not a stable contract). Unknown categories not in that map sort
// alphabetically after all known ones. 'uncategorized' always renders last,
// even though it appears earliest in AGENT_METRICS_CATEGORY_LABELS.
{
  const scrambledSnapshot = {
    ...validSnapshot,
    metrics: [
      { key: 'legacy_metric', label: 'legacy_metric', value: 1, unit: null, source_window: 'telemetry', freshness: 'fresh' },
      { key: 'ctx_age', label: 'ctx_age', value: 3, unit: 'min', category: 'knowledge_freshness', source_window: 'telemetry', freshness: 'fresh' },
      { key: 'token_cost', label: 'token_cost', value: 9, unit: 'usd', category: 'resource_cost', source_window: 'telemetry', freshness: 'fresh' },
      { key: 'zzz_metric', label: 'zzz_metric', value: 2, unit: null, category: 'zzz_future_category', source_window: 'telemetry', freshness: 'fresh' },
    ],
  }
  const mounted = await mountPage(scrambledSnapshot)
  const cards = [...mounted.container.querySelectorAll('[data-metrics-category]')]
  const order = cards.map((el) => el.getAttribute('data-metrics-category'))
  assert.deepEqual(order, ['resource_cost', 'knowledge_freshness', 'zzz_future_category', 'uncategorized'])
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

// Unrecognized/future category keys must render using the raw key text
// as their visible category label (the safe fallback in
// agentMetricsCategoryLabel), since the label map is a forward-looking,
// non-exhaustive lookup table, not a verified/exhaustive contract.
{
  const snapshotWithNovelCategory = {
    ...validSnapshot,
    metrics: [
      {
        key: 'novel_metric',
        label: 'novel_metric',
        value: 7,
        unit: null,
        category: 'novel_future_category_xyz',
        source_window: 'telemetry',
        freshness: 'fresh',
      },
    ],
  }
  const mounted = await mountPage(snapshotWithNovelCategory)
  const rendered = text(mounted.container)
  assert.match(rendered, /novel_future_category_xyz/i, 'unrecognized category must fall back to its raw key as the label')
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

// The category-label map's comment must not claim a mirrored Python
// module that does not exist anywhere in this repo's backend/ tree.
{
  const pluginPath = fileURLToPath(new URL('../plugin.js', import.meta.url))
  const pluginSource = readFileSync(pluginPath, 'utf8')
  assert.doesNotMatch(pluginSource, /db\/metrics_db\.py/, 'plugin.js must not claim a nonexistent mirrored Python module')
  assert.doesNotMatch(pluginSource, /MetricCategory/, 'plugin.js must not reference a nonexistent MetricCategory type')
}

console.log('agent-metrics-fullpage acceptance tests reached')
