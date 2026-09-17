import assert from 'node:assert/strict'
import { collectRegistrations } from './render-harness.mjs'

// The old /decision-hud/agent-dashboard reveal-and-redirect placeholder
// route no longer exists (2026-09 owner decision — see pinned-pane.test.mjs):
// Agent Dashboard now defaults to 'session-tab' placement, docking as a real
// SESSIONS-zone tab with no route needed to reach it.
const ROUTE_PATH = '/decision-hud/agent-dashboard'
const registrations = collectRegistrations()
const route = registrations.find((registration) => (
  registration.area === 'routes' && registration.data?.path === ROUTE_PATH
))

assert.equal(route, undefined, `${ROUTE_PATH} route must no longer exist — Agent Dashboard is a session-tab pane now`)

const pane = registrations.find((registration) => (
  registration.area === 'panes' && registration.id === 'decision-hud:agent-dashboard'
))
assert.ok(pane, 'the Agent Dashboard pane registration must still exist')
assert.deepEqual(pane.data?.dock, { pane: 'sessions', pos: 'center', enforce: true }, 'Agent Dashboard must default to session-tab placement')

console.log('agent-dashboard-repair (session-tab, no route) regression test passed')
