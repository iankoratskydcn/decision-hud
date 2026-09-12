import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// "swap the agent health and the metrics cards so metrics is on the bottom":
// AgentHealthList must now render BEFORE the metric dials inside
// MetricsSidebar's children array, not after.
const sidebarFnBody = source.match(/function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(sidebarFnBody, 'MetricsSidebar function body must exist')
const body = sidebarFnBody[0]

const agentHealthIdx = body.indexOf('jsx(AgentHealthList,')
const firstDialIdx = body.indexOf("jsx(MetricDial,")
assert.ok(agentHealthIdx !== -1, 'AgentHealthList must be rendered inside MetricsSidebar')
assert.ok(firstDialIdx !== -1, 'at least one MetricDial must be rendered inside MetricsSidebar')
assert.ok(
  agentHealthIdx < firstDialIdx,
  'AgentHealthList must render BEFORE the metric dials (metrics moved to the bottom)',
)

console.log('sidebar-order-swap (agent health above metrics dials) structural test passed')
