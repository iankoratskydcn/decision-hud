import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// 1. Sidebar position (left/right) and size must be persisted settings,
// not the hardcoded 'w-1/4 max-w-[200px] ... border-r' from before.
const SIDEBAR_STORAGE_KEY_RE = /SIDEBAR_SETTINGS_STORAGE_KEY\s*=\s*['"]decision-hud:sidebar-settings['"]/
assert.match(source, SIDEBAR_STORAGE_KEY_RE, 'a sidebar-settings localStorage key constant must exist')

assert.match(
  source,
  /function loadSidebarSettings\(\)/,
  'loadSidebarSettings() must exist (mirrors loadGridLayout)',
)
assert.match(
  source,
  /function saveSidebarSettings\(/,
  'saveSidebarSettings() must exist (mirrors saveGridLayout)',
)

// 2. MetricsSidebar must accept a size/side-configurable width class and a
// position, not hardcode 'w-1/4 max-w-[200px]' and 'border-r' unconditionally.
const sidebarFnMatch = source.match(/function MetricsSidebar\(\{([^}]*)\}\)/)
assert.ok(sidebarFnMatch, 'MetricsSidebar function declaration must exist')
assert.match(
  sidebarFnMatch[1],
  /side/,
  'MetricsSidebar must accept a side prop (left/right)',
)
assert.match(
  sidebarFnMatch[1],
  /widthPx|width/,
  'MetricsSidebar must accept a width-related prop instead of a hardcoded class',
)

// 3. DecisionHudPane must read/write these settings the same way gridLayout
// does, and pass side/width through, and the row of children must place
// MetricsSidebar on the side the setting says (left is the append-order
// default -- 'right' means MetricsSidebar renders AFTER the main column).
const paneMatch = source.match(/function DecisionHudPane\(\) \{[\s\S]*?\n\}\n/)
assert.ok(paneMatch, 'DecisionHudPane function must exist')
const pane = paneMatch[0]
assert.match(
  pane,
  /const \[sidebarSettings, setSidebarSettings\] = React\.useState\(loadSidebarSettings\)/,
  'DecisionHudPane must track sidebarSettings state initialized from loadSidebarSettings',
)
assert.match(
  pane,
  /jsx\(MetricsSidebar,\s*\{[^}]*side:\s*sidebarSettings\.side/,
  'MetricsSidebar must be rendered with side: sidebarSettings.side',
)

console.log('sidebar-settings (position + size persisted) structural test passed')
