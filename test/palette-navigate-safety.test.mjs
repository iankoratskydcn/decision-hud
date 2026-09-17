import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for a BLOCKING code-review finding: host.navigate is
// unproven by any mechanism exercised live in this repo (see commit
// 9d31e1a) and must never be called from plugin.js.
assert.doesNotMatch(
  source,
  /host\.navigate\(/,
  'host.navigate is unproven by any mechanism already exercised live in this repo — do not call it from plugin.js',
)

assert.doesNotMatch(
  source,
  /id:\s*'open-agent-metrics'/,
  "the redundant 'open-agent-metrics' palette command must not be registered",
)

// 2026-09 owner decision: SIDEBAR_NAV_AREA rows are gone entirely for these
// panes (see pinned-pane.test.mjs) because a nav row only carries a `path`,
// forcing every click through a ROUTES_AREA round-trip that flashed/reloaded
// live. Decision HUD, Agent Dashboard, and Task List now default to
// 'session-tab' placement instead — real tabs in the SESSIONS zone, same
// mechanism the built-in Bots pane uses, with no nav row and no route
// needed to reach them. The Agent Metrics FULL PAGE (AGENT_METRICS_ROUTE_PATH)
// still exists as a direct-deep-link-only route with no nav row pointing at
// it — assert that reachability, not a nav entry.
assert.doesNotMatch(
  source,
  /area:\s*SIDEBAR_NAV_AREA/,
  'no SIDEBAR_NAV_AREA row should be registered for Decision HUD / Agent Dashboard / Task List anymore — they reach the user as session-tab panes instead, never via a route-backed sidebar nav row',
)

assert.match(
  source,
  /id:\s*'agent-metrics-route'[\s\S]{0,120}data:\s*\{\s*path:\s*AGENT_METRICS_ROUTE_PATH/,
  'the Agent Metrics full page must remain reachable via its ROUTES_AREA registration (direct deep link), even with no sidebar-nav row pointing at it',
)

console.log('palette-navigate-safety regression test passed')
