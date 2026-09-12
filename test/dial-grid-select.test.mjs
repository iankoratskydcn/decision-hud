import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// A grid-select control for dial layout (cols) must exist, same shape as
// GridLayoutControls (stepper buttons), but a distinct component/setting
// since it controls the METRICS DIALS layout, not the decision-card grid.
assert.match(
  source,
  /function DialGridControls\(/,
  'DialGridControls component must exist',
)

// It must be wired into the sidebar settings state (persisted alongside
// side/width), not a separate one-off localStorage key.
assert.match(
  source,
  /function loadSidebarSettings\(\)[\s\S]{0,1200}dialCols/,
  'loadSidebarSettings must load a dialCols field',
)
assert.match(
  source,
  /function saveSidebarSettings\([\s\S]{0,200}\)[\s\S]{0,50}\{/,
  'saveSidebarSettings must exist to persist the sidebar settings object (incl. dialCols)',
)

// MetricsSidebar must actually use dialCols to lay dials out in a grid
// (grid-template-columns), not a fixed vertical flex stack.
const sidebarFnBody = source.match(/function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(sidebarFnBody, 'MetricsSidebar function body must exist')
assert.match(
  sidebarFnBody[0],
  /gridTemplateColumns:\s*`repeat\(\$\{.*dialCols.*\},/,
  'MetricsSidebar must apply a CSS grid with dialCols columns to the dials',
)

// The settings popover must expose the dial grid-select control.
const settingsPopoverDef = source.match(/function SettingsPopover\([\s\S]*?\n\}\n/)
assert.ok(settingsPopoverDef, 'SettingsPopover component must be defined')
assert.match(
  settingsPopoverDef[0],
  /jsx\(DialGridControls,/,
  'SettingsPopover must render DialGridControls',
)

console.log('dial-grid-select structural test passed')
