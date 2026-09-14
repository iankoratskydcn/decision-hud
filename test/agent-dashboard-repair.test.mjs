import assert from 'node:assert/strict'
import { collectRegistrations } from './render-harness.mjs'
import { renderRegistration } from './render-harness.mjs'

const ROUTE_PATH = '/decision-hud/agent-dashboard'
const registrations = collectRegistrations()
const route = registrations.find((registration) => (
  registration.area === 'routes' && registration.data?.path === ROUTE_PATH
))

assert.ok(route, `expected dashboard route at ${ROUTE_PATH}`)
const rendered = renderRegistration(route)
assert.equal(rendered.error, null, 'dashboard route must render without throwing')
assert.match(rendered.html, /Agent Dashboard/i)

// The route is a placeholder rather than a second live dashboard tree, but it
// must still give keyboard and mouse users a native actionable reveal control.
assert.match(rendered.html, /<button\b/i, 'route must contain a native button')
assert.match(rendered.html, /Show Agent Dashboard/i)
assert.match(rendered.html, /type="button"/i)
assert.match(rendered.html, /aria-label="Show Agent Dashboard"/i)

console.log('agent-dashboard-repair UI acceptance test reached')
