import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for "Decision HUD disappears when I switch chats": the
// pane must be registered on the panes area (docked beside the workspace,
// survives session/route switches) in addition to whatever route exists for
// the sidebar nav row, not solely as a route.
assert.match(
  source,
  /ctx\.register\(\{\s*id:\s*PANE_ID,\s*area:\s*'panes'/,
  'Decision HUD must register DecisionHudPane on the panes area (docked pane), not only as a route',
)

assert.match(
  source,
  /dock:\s*\{\s*pane:\s*'workspace',\s*pos:\s*'right'\s*\}/,
  'the docked pane must anchor beside the workspace so it persists across chat/session switches',
)

// Regression guard for the follow-up bug: a route that renders null (to
// "just reveal the docked pane") does not work with this app's router —
// navigating to a ROUTES_AREA page fronts the WORKSPACE pane's own content,
// which is whatever chat sits behind it when the route renders nothing.
// Confirmed live: clicking the old stub route showed a chat, not the HUD.
// The route must render the real panel, not a no-op/effect-only stub.
assert.doesNotMatch(
  source,
  /function DecisionHudRevealRoute/,
  'the /decision-hud route must not be a render-null reveal-effect stub — it does not front the docked pane in this router and instead exposes whatever chat sits behind the workspace pane',
)

assert.match(
  source,
  /area:\s*ROUTES_AREA,\s*data:\s*\{\s*path:\s*'\/decision-hud'\s*\},\s*render:\s*\(\)\s*=>\s*jsx\(DecisionHudPane/,
  'the /decision-hud route must render DecisionHudPane directly so the sidebar nav row actually shows the HUD instead of falling through to chat',
)

assert.match(
  source,
  /host\.revealPane\(PANE_ID\)/,
  'the palette command must still call host.revealPane(PANE_ID) to re-surface the docked pane specifically',
)

console.log('pinned-pane (docked pane + working route fallback) regression test passed')
