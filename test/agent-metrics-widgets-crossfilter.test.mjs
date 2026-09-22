// TDD for click-to-isolate cross-filtering across the six agent-metrics
// widgets (heatmap/scatter/parallel-coordinates/treemap/radar/sankey):
// clicking a heatmap cell (or a treemap/radar/sankey assignee mark) sets a
// shared { assignee, outcome } selection that every OTHER widget reads to
// dim its non-matching marks — the "click one thing, see it everywhere"
// visual-triage feature requested after the merge to the combined Agent
// Dashboard page. Reuses the same dom-harness/cli.exec-stub pattern as
// agent-metrics-widgets.test.mjs.
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
    { assignee: 'reviewer', outcome: 'blocked', volume: 3, avg_duration_s: 80, cost_status: 'unavailable', cost_usd: null },
    { assignee: 'reviewer', outcome: 'crashed', volume: 1, avg_duration_s: 15, cost_status: 'unavailable', cost_usd: null },
  ],
  handoffs: [
    { from: 'builder', to: 'reviewer', volume: 8 },
    { from: 'reviewer', to: 'builder', volume: 1 },
  ],
}

// Clicking a heatmap cell dims every other cell (opacity drops) and marks
// the clicked cell as the exact selection; a persistent "Isolated: ..."
// summary bar appears with a Clear control.
{
  const mounted = await mountPage(() => ({ code: 0, output: JSON.stringify(sampleSnapshot) }))
  const cells = [...mounted.container.querySelectorAll('[data-heatmap-cell]')]
  assert.ok(cells.length > 0, 'expected heatmap cells to render')
  const builderCompleted = cells.find((c) => c.title.includes('builder') && c.title.includes('completed'))
  assert.ok(builderCompleted, 'expected a builder/completed heatmap cell')

  builderCompleted.click()
  await flush()

  // Selection bar appears, names both fields, offers Clear.
  const rendered = text(mounted.container)
  assert.match(rendered, /Isolated:/)
  assert.match(rendered, /assignee = builder/)
  assert.match(rendered, /outcome = completed/)
  const clearBtn = [...mounted.container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear')
  assert.ok(clearBtn, 'expected a Clear button once a selection is active')

  // Every OTHER heatmap cell is now visibly dimmed (opacity != 1); the
  // clicked cell itself stays at full opacity.
  const otherCell = cells.find((c) => c !== builderCompleted && c.title.includes('reviewer'))
  assert.ok(otherCell, 'expected a non-matching cell to compare against')
  assert.notEqual(otherCell.style.opacity, '1', 'non-matching heatmap cell should be dimmed')
  assert.equal(builderCompleted.style.opacity, '1', 'matching heatmap cell should stay at full opacity')

  // Clicking Clear resets the selection bar away.
  clearBtn.click()
  await flush()
  assert.doesNotMatch(text(mounted.container), /Isolated:/)

  await mounted.unmount()
}

// Clicking the same heatmap cell twice toggles the selection back off
// (click-to-isolate, click-again-to-clear), without needing the Clear button.
{
  const mounted = await mountPage(() => ({ code: 0, output: JSON.stringify(sampleSnapshot) }))
  const cells = [...mounted.container.querySelectorAll('[data-heatmap-cell]')]
  const builderCompleted = cells.find((c) => c.title.includes('builder') && c.title.includes('completed'))
  builderCompleted.click()
  await flush()
  assert.match(text(mounted.container), /Isolated:/)
  builderCompleted.click()
  await flush()
  assert.doesNotMatch(text(mounted.container), /Isolated:/)
  await mounted.unmount()
}

// Clicking a treemap segment isolates by assignee only (no outcome set),
// which is a partial selection other widgets (scatter/radar/sankey) must
// also respect — verified indirectly via the selection bar text (assignee
// only, no "outcome =" fragment).
{
  const mounted = await mountPage(() => ({ code: 0, output: JSON.stringify(sampleSnapshot) }))
  const treemapRects = mounted.container.querySelectorAll('[data-widget="treemap"] svg rect')
  assert.ok(treemapRects.length > 0, 'expected treemap rects to render')
  // The <rect> itself has no click handler (its parent <g> does, per the
  // implementation) — dispatch on the parent to match real click bubbling.
  const firstRectGroup = treemapRects[0].closest('g')
  assert.ok(firstRectGroup, 'expected treemap rect to have a parent <g> click target')
  firstRectGroup.dispatchEvent(new mounted.container.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }))
  await flush()
  const rendered = text(mounted.container)
  assert.match(rendered, /Isolated: assignee = /)
  assert.doesNotMatch(rendered, /outcome = /, 'a treemap click should only set assignee, not outcome')
  await mounted.unmount()
}

console.log('agent-metrics-widgets-crossfilter acceptance tests reached')
