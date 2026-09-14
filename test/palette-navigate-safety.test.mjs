import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for a BLOCKING code-review finding: the 'open-agent-metrics'
// PALETTE_AREA command's run() called host.navigate(AGENT_METRICS_ROUTE_PATH).
// host.navigate is used NOWHERE else in this file — every other palette/route
// affordance reaches the user via host.revealPane(...) or a real `path` on a
// ROUTES_AREA/SIDEBAR_NAV_AREA registration, both of which are mechanisms this
// exact repo has already proven safe live (see commit 9d31e1a, "fix: Agent
// Dashboard failed to load in real desktop app" — a mechanism that looked fine
// against the mocked @hermes/plugin-sdk test harness broke in the real desktop
// app because the harness's fake `host` doesn't prove anything about the real
// app's host object). node_modules/@hermes/plugin-sdk's fake SDK defines
// `navigate` as a no-op mock identical in shape to `revealPane`'s mock, so a
// test asserting only "run() doesn't throw" would stay green either way and
// prove nothing about which one is real.
//
// Fix: the full-page route is already reachable through the proven `path`
// mechanism via the 'agent-metrics-nav' SIDEBAR_NAV_AREA registration, so the
// redundant palette command — the only call site anywhere in this file that
// depended on an unproven host.navigate — is removed rather than kept on a
// capability this repo has no in-house evidence for.
assert.doesNotMatch(
  source,
  /host\.navigate\(/,
  'host.navigate is unproven by any mechanism already exercised live in this repo (unlike host.revealPane and the ROUTES_AREA/SIDEBAR_NAV_AREA `path` fields) — do not call it from plugin.js',
)

assert.doesNotMatch(
  source,
  /id:\s*'open-agent-metrics'/,
  "the redundant 'open-agent-metrics' palette command (whose only job was to wrap the now-removed host.navigate call) must not be registered — the route is already reachable via the proven 'agent-metrics-nav' SIDEBAR_NAV_AREA path entry",
)

// The proven mechanisms must still be present and doing the reachability work.
assert.match(
  source,
  /id:\s*'agent-metrics-nav'[\s\S]{0,200}data:\s*\{\s*path:\s*AGENT_METRICS_ROUTE_PATH/,
  'the Agent Metrics full page must remain reachable via the proven SIDEBAR_NAV_AREA `path` mechanism',
)

console.log('palette-navigate-safety regression test passed')
