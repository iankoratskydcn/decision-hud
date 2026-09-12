import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Isolate the DecisionHudPane function body so assertions are scoped to it
// rather than matching unrelated code elsewhere in the file.
const paneMatch = source.match(/function DecisionHudPane\(\) \{[\s\S]*?\n\}\n/)
assert.ok(paneMatch, 'DecisionHudPane function must exist')
const pane = paneMatch[0]

// 1. A gear/settings toggle state must exist.
assert.match(
  pane,
  /const \[settingsOpen, setSettingsOpen\] = React\.useState\(false\)/,
  'DecisionHudPane must track an open/closed boolean state for the settings popover',
)

// 2. A gear/settings button element must exist in the render tree.
assert.match(
  pane,
  /['"]?aria-label['"]?:\s*'(?:Settings|Grid settings|Open settings)'/,
  'a gear/settings button with an aria-label must exist in the render tree',
)
assert.match(
  pane,
  /onClick:\s*\(\)\s*=>\s*setSettingsOpen\(\(v\)\s*=>\s*!v\)/,
  'the gear button must toggle settingsOpen on click',
)

// 3. A popover/panel component conditionally rendered based on settingsOpen.
assert.match(
  pane,
  /settingsOpen\s*&&\s*jsxs?\(\s*SettingsPopover/,
  'a SettingsPopover must be conditionally rendered based on settingsOpen',
)

// 4. GridLayoutControls must now be referenced from inside SettingsPopover,
//    not directly inline in the old header row next to ProjectSwitcher.
const settingsPopoverDef = source.match(/function SettingsPopover\([\s\S]*?\n\}\n/)
assert.ok(settingsPopoverDef, 'SettingsPopover component must be defined')
assert.match(
  settingsPopoverDef[0],
  /jsx\(GridLayoutControls,/,
  'SettingsPopover must render GridLayoutControls',
)

// The old inline placement (directly beside ProjectSwitcher in the same
// children array) must be gone.
assert.doesNotMatch(
  pane,
  /jsx\(ProjectSwitcher,[\s\S]*?jsx\(GridLayoutControls,/,
  'GridLayoutControls must no longer sit inline next to ProjectSwitcher',
)

console.log('settings gear popover structural test passed')
