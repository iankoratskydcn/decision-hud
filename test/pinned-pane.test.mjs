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

// Regression guard for the third bug in this saga: rendering the REAL
// DecisionHudPane on the route (a subsequent attempt, replacing the
// earlier reveal-effect stub) fixed "shows a chat instead of the HUD" but
// introduced a NEW bug — it created a second, fully independent live
// instance (own state, own poll loop) alongside the always-on docked pane,
// and a live screenshot caught both instances rendering visibly divergent
// UI (different settings-popover open/closed state) on screen at once. The
// route must render neither a null-effect stub nor a second real
// DecisionHudPane — only a static, non-stateful placeholder that reveals
// the ONE docked instance.
assert.doesNotMatch(
  source,
  /area:\s*ROUTES_AREA,\s*data:\s*\{\s*path:\s*'\/decision-hud'\s*\},\s*render:\s*\(\)\s*=>\s*jsx\(DecisionHudPane/,
  'the /decision-hud route must NOT render a second live DecisionHudPane — it duplicates state/poll loops and produces visibly divergent UI in the two instances (confirmed live via screenshot)',
)

assert.match(
  source,
  /function DecisionHudRoutePlaceholder\(\)/,
  'the /decision-hud route must render a static, non-polling placeholder component distinct from DecisionHudPane',
)

assert.match(
  source,
  /area:\s*ROUTES_AREA,\s*data:\s*\{\s*path:\s*'\/decision-hud'\s*\},\s*render:\s*\(\)\s*=>\s*jsx\(DecisionHudRoutePlaceholder/,
  'the /decision-hud route must render DecisionHudRoutePlaceholder, not DecisionHudPane and not a null-returning stub',
)

assert.match(
  source,
  /host\.revealPane\(PANE_ID\)/,
  'something (the route placeholder button and/or the palette command) must call host.revealPane(PANE_ID) to re-surface the ONE docked pane instead of duplicating it',
)

console.log('pinned-pane (docked pane + working route fallback) regression test passed')
