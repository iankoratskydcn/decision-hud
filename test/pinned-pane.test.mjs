import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for "Decision HUD disappears when I switch chats": the
// pane must be registered on the panes area (docked beside the workspace,
// survives session/route switches), not directly on ROUTES_AREA as the
// live/only DecisionHudPane instance.
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

// The route registration must exist only to satisfy SidebarNavContribution's
// path requirement and must NOT itself render DecisionHudPane a second time
// (that would mean two live polling instances).
assert.doesNotMatch(
  source,
  /area:\s*ROUTES_AREA,\s*data:\s*\{\s*path:\s*'\/decision-hud'\s*\},\s*render:\s*\(\)\s*=>\s*jsx\(DecisionHudPane/,
  'the /decision-hud route must not render DecisionHudPane directly — that would create a second live instance alongside the docked pane',
)

assert.match(
  source,
  /function DecisionHudRevealRoute\(\)/,
  'the /decision-hud route must be a reveal-only stub that calls host.revealPane, not a second DecisionHudPane mount',
)

assert.match(
  source,
  /host\.revealPane\(PANE_ID\)/,
  'something (route effect and/or palette command) must call host.revealPane(PANE_ID) to re-surface the pane',
)

console.log('pinned-pane (docked, not route-replaced) regression test passed')
