import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// A useAgentHealth-style hook must exist and poll on the same POLL_MS cadence
// as the other data hooks in this file (useKanbanBoards, useHudMetrics).
assert.match(
  source,
  /function useAgentHealth\(telemetryByAgent\)/,
  'useAgentHealth hook must exist',
)
assert.match(
  source,
  /function useAgentHealth\(telemetryByAgent\)[\s\S]*?setInterval\((?:poll|refresh), POLL_MS\)/,
  'useAgentHealth must poll on the shared POLL_MS interval like the other hooks',
)

// It must derive its roster from the real CLI, not fabricate agents.
assert.match(
  source,
  /function useAgentHealth\(telemetryByAgent\)[\s\S]{0,4000}cliExec\(\['kanban', 'assignees', '--json'\]\)/,
  'useAgentHealth must call `hermes kanban assignees --json` via cliExec',
)

// It must also look at kanban stats for real per-assignee/global signal
// rather than inventing a score out of thin air.
assert.match(
  source,
  /function useAgentHealth\(telemetryByAgent\)[\s\S]{0,4000}cliExec\(\['kanban', 'stats', '--json'\]\)/,
  'useAgentHealth must call `hermes kanban stats --json` via cliExec',
)

// No Math.random or similarly fabricated scoring inside the hook body.
const hookBodyMatch = source.match(/function useAgentHealth\(telemetryByAgent\)([\s\S]*?)\n}\n/)
assert.ok(hookBodyMatch, 'useAgentHealth body must be extractable for fabrication check')
assert.doesNotMatch(
  hookBodyMatch[1],
  /Math\.random/,
  'useAgentHealth must never fabricate a health score with Math.random',
)

// MetricsSidebar (or a component it renders) must render a sorted agent
// health list fed by useAgentHealth, distinct from the existing dials.
assert.match(
  source,
  /function AgentHealthList\(/,
  'AgentHealthList component must exist',
)
assert.match(
  source,
  /jsx\(AgentHealthList,/,
  'MetricsSidebar must render AgentHealthList',
)

// The list must actually sort unhealthiest-first (descending by blocked
// count is the agreed MVP scoring rule) rather than leaving CLI order as-is.
assert.match(
  source,
  /\.sort\(/,
  'agent health data must be explicitly sorted, not left in raw CLI order',
)

console.log('agent-health structural test passed')
