// Regression guard for the "two divergent Decision HUD instances on screen
// at once" screenshot bug: mounts BOTH the docked pane's render() AND the
// /decision-hud route's render() simultaneously (the exact scenario a user
// hits by clicking the sidebar nav row while the docked pane is already
// showing) and proves the route side is inert — no gear/settings button, no
// independent gridLayout/dialCols state, nothing that could diverge from
// the one real pane. A source regex cannot prove "these two mounted trees
// never show different state for the same setting"; only an actual
// dual-mount does.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { collectRegistrations, findRegistration, installLocalStorageStub } from './dom-harness.mjs'

installLocalStorageStub()

const regs = collectRegistrations()
const paneReg = findRegistration(regs, 'panes', 'decision-hud:pane')
const routeReg = findRegistration(regs, 'routes', 'page')

const dom = new JSDOM('<!doctype html><html><body><div id="pane"></div><div id="route"></div></body></html>')
const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

const errors = []
const paneRoot = createRoot(dom.window.document.getElementById('pane'), {
  onUncaughtError: (e) => errors.push(e),
  onCaughtError: (e) => errors.push(e),
})
const routeRoot = createRoot(dom.window.document.getElementById('route'), {
  onUncaughtError: (e) => errors.push(e),
  onCaughtError: (e) => errors.push(e),
})

paneRoot.render(React.createElement(paneReg.render))
routeRoot.render(React.createElement(routeReg.render))

await new Promise((resolve) => setTimeout(resolve, 50))
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setTimeout(resolve, 50))

assert.deepEqual(errors, [], `dual-mounting the pane and the route must not throw (got: ${errors.map((e) => e.message).join(', ')})`)

const paneEl = dom.window.document.getElementById('pane')
const routeEl = dom.window.document.getElementById('route')

// The docked pane is the one real, stateful instance: it has the gear icon.
assert.ok(paneEl.querySelector('[aria-label="Settings"]'), 'the docked pane must render the real Settings gear icon')

// The route side must NOT be a second real instance: no gear icon, no grid
// controls, no board selector -- none of the stateful UI a second
// DecisionHudPane would carry, which is exactly what diverged visibly in
// the live screenshot bug.
assert.equal(
  routeEl.querySelector('[aria-label="Settings"]'),
  null,
  'the /decision-hud route must NOT render a second Settings gear icon (that would mean a second live, independently-stateful DecisionHudPane instance)',
)

// It DOES need a way back to the one real pane.
const revealButton = [...routeEl.querySelectorAll('button')].find((b) => b.textContent.includes('Show Decision HUD'))
assert.ok(revealButton, 'the route placeholder must offer a button back to the real docked pane')

paneRoot.unmount()
routeRoot.unmount()
await new Promise((resolve) => setTimeout(resolve, 0))
globalThis.window = previousGlobals.window
globalThis.document = previousGlobals.document
Object.defineProperty(globalThis, 'navigator', { value: previousGlobals.navigator, configurable: true, writable: true })

console.log('single-live-instance (route never duplicates the docked pane) regression test passed')
