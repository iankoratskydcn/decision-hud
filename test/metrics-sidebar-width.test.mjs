import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// MetricsSidebar (left-hand metrics/dials panel) should size to ~1/4 of the
// pane's horizontal space, capped at 200px so it never dominates a wide
// docked pane.
const sidebarClassMatch = source.match(
  /function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?className:\s*'([^']*)'/,
)
assert.ok(sidebarClassMatch, 'MetricsSidebar must have a className on its root div')

const cls = sidebarClassMatch[1]
assert.match(cls, /\bw-1\/4\b/, 'MetricsSidebar root must use w-1/4 (~one quarter of horizontal space)')
assert.match(cls, /max-w-\[200px\]/, 'MetricsSidebar root must cap width at max-w-[200px]')
assert.doesNotMatch(cls, /\bw-\[160px\]\b/, 'the old fixed 160px width must be gone')

console.log('metrics-sidebar-width (1/4 width, 200px cap) regression test passed')
