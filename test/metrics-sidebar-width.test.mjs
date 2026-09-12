import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// MetricsSidebar (metrics/dials panel) width is now a user-configurable
// setting (loadSidebarSettings().widthPx, default 200, adjustable in the
// gear settings popover), replacing the earlier hardcoded w-1/4/max-w-[200px]
// className approach — see sidebar-settings.test.mjs for the settings
// contract itself. This test now pins the width being applied inline via
// style rather than via a fixed utility class.
const sidebarFnBody = source.match(/function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(sidebarFnBody, 'MetricsSidebar function body must exist')

assert.match(
  sidebarFnBody[0],
  /style:\s*\{\s*width:\s*`\$\{widthPx\}px`/,
  'MetricsSidebar must apply widthPx via inline style, not a fixed w-1/4 class',
)
assert.doesNotMatch(
  sidebarFnBody[0],
  /\bw-1\/4\b/,
  'the old fixed w-1/4 class must be gone now that width is a setting',
)
assert.doesNotMatch(
  sidebarFnBody[0],
  /\bw-\[160px\]\b/,
  'the old fixed 160px width must be gone',
)

console.log('metrics-sidebar-width (now a configurable setting, not a fixed class) regression test passed')

