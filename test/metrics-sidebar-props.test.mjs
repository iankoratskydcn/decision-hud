import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for the live crash "agentHealth is not defined":
// MetricsSidebar is called as jsx(MetricsSidebar, { metrics, agentHealth })
// but its function signature only destructured `metrics`, so the JSX below
// referencing bare `agentHealth` hit ReferenceError at render time.
const sidebarFnMatch = source.match(/function MetricsSidebar\(\{([^}]*)\}\)/)
assert.ok(sidebarFnMatch, 'MetricsSidebar function declaration must exist')
assert.match(
  sidebarFnMatch[1],
  /agentHealth/,
  'MetricsSidebar must destructure agentHealth from its props (it is called with { metrics, agentHealth } and its body reads bare `agentHealth`)',
)

assert.match(
  source,
  /jsx\(AgentHealthList,\s*\{\s*health:\s*agentHealth,\s*availableMetrics\s*\}\)/,
  'MetricsSidebar must still render AgentHealthList fed by the (now-destructured) agentHealth prop',
)

console.log('metrics-sidebar-props (agentHealth destructure) regression test passed')
