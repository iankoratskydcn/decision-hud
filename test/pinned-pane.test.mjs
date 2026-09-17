import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for "Decision HUD disappears when I switch chats": the
// pane must be registered on the panes area so it survives session/route
// switches (whichever placement the user picked — 'right' docked or
// 'session-tab' — both come from `panes`, never a ROUTES_AREA-only surface).
assert.match(
  source,
  /ctx\.register\(\{\s*id:\s*PANE_ID,\s*area:\s*'panes'/,
  'Decision HUD must register DecisionHudPane on the panes area (docked pane), not only as a route',
)

// 2026-09 owner decision: clicking Decision HUD / Agent Metrics / Task List
// in the sidebar visibly flashed/reloaded, because SidebarNavContribution
// only accepts a `path` (no onClick), so every click routed through
// ROUTES_AREA first — even the reveal-and-redirect placeholder pattern
// (navigate away, then host.revealPane + history.back()) produced a
// visible round-trip. Fix: these panes default to 'session-tab' placement,
// docking as real SESSIONS-zone tabs (the Bots-pane mechanism) with NO
// sidebar-nav row and NO route at all — the tab strip click switches tabs
// directly, no navigation event. Guard against regressing to the old
// nav-row/route-placeholder shape for the docked Decision HUD pane.
assert.doesNotMatch(
  source,
  /function DecisionHudRoutePlaceholder/,
  'the /decision-hud route/nav-row reveal-and-redirect placeholder must not return — it round-trips through history and flashes on every click (confirmed live); session-tab placement replaces it',
)

assert.doesNotMatch(
  source,
  /id:\s*'nav',\s*area:\s*SIDEBAR_NAV_AREA[\s\S]{0,120}'\/decision-hud'/,
  'Decision HUD must not register a SIDEBAR_NAV_AREA row for /decision-hud — sidebar-nav rows only carry a `path`, forcing a route round-trip that flashes on click',
)

assert.match(
  source,
  /const DEFAULT_PANE_PLACEMENT = \{ decisionHud: 'session-tab', agentDashboard: 'session-tab', taskList: 'session-tab' \}/,
  'Decision HUD, Agent Dashboard, and Task List must default to session-tab placement (real SESSIONS-zone tabs), not the old right-docked default',
)

console.log('pinned-pane (docked pane, session-tab default, no flash-inducing nav route) regression test passed')
