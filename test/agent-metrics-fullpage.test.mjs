// Wave 2b: /decision-hud/agent-metrics is retired as a visible nav entry.
// The route itself stays registered (old links/bookmarks/palette entries
// keep working for one release cycle) but now renders a redirect to the
// canonical /decision-hud/agent-dashboard page instead of its own
// full-page dashboard — an alias, not a second page.
import assert from 'node:assert/strict'
import { collectRegistrations as collectRendered } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const ROUTE_PATH = '/decision-hud/agent-metrics'
const CANONICAL_ROUTE_PATH = '/decision-hud/agent-dashboard'

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function findNav(registrations, path) {
  return registrations.find((r) => r.area === 'sidebar-nav' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

const registrations = collectRendered()

// Route is still registered — old links/bookmarks must not 404.
const route = findRoute(registrations, ROUTE_PATH)
assert.ok(route, `expected a ${ROUTE_PATH} route registration to remain for alias/redirect`)
assert.ok(findRoute(registrations, '/decision-hud'), 'Decision HUD page route must exist')
assert.ok(findRoute(registrations, '/decision-hud/agent-metrics/snapshot'), 'Agent Matrix page route must exist')

// Nav entry is gone — Agent Metrics is no longer a visible sidebar destination.
assert.equal(findNav(registrations, ROUTE_PATH), undefined, 'Agent Metrics sidebar nav entry must be removed')

// Visiting the retired route redirects to the canonical page.
{
  const originalNavigate = host.navigate
  const navigated = []
  host.navigate = (path) => navigated.push(path)
  const mounted = mount(route.render)
  await flush()
  assert.deepEqual(navigated, [CANONICAL_ROUTE_PATH], 'retired route must redirect to the canonical Agent Dashboard route')
  assert.match(text(mounted.container), /moved|redirect/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
  host.navigate = originalNavigate
}

console.log('agent-metrics-fullpage retirement/redirect tests reached')
