import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Kanban escalation bridge scope: which kanban_block()/kanban_request_review()
// calls should auto-push a Decision HUD card. Must be a persisted HUD setting
// (same key/value store as subagent_inject_enabled), not a hardcoded constant,
// so the owner can change it from the pane without editing skill/code files.

// 1. A dedicated hook must exist, mirroring useSubagentRuleSettings's shape
//    (settings-get/settings-set bridge), not a one-off local useState.
const hookDef = source.match(/function useKanbanEscalationScope\(\)[\s\S]*?\n\}\n/)
assert.ok(hookDef, 'useKanbanEscalationScope hook must be defined')
assert.match(
  hookDef[0],
  /cliExec\(\['decision', 'settings-get'\]\)/,
  'useKanbanEscalationScope must read the persisted scope via `hermes decision settings-get`',
)
assert.match(
  hookDef[0],
  /cliExec\(\['decision', 'settings-set', 'kanban_escalation_bridge_scope', /,
  'useKanbanEscalationScope must persist the scope via `hermes decision settings-set kanban_escalation_bridge_scope`',
)

// 2. A tab component must expose exactly the 3 supported scope values as a
//    selectable control (radio-style buttons), not a boolean toggle — scope
//    is a tri-state selection (off / needs_input / all), not on/off. The
//    option list may live in a sibling constant consumed by the component
//    (matching the codebase's constant-array-of-options idiom elsewhere),
//    so scope the check to that constant + the component together.
const tabDef = source.match(/function KanbanEscalationScopeTab\([\s\S]*?\n\}\n/)
assert.ok(tabDef, 'KanbanEscalationScopeTab component must be defined')
const optionsDef = source.match(/KANBAN_ESCALATION_SCOPE_OPTIONS = \[[\s\S]*?\n\]\n/)
assert.ok(optionsDef, 'KANBAN_ESCALATION_SCOPE_OPTIONS options list must be defined')
assert.match(tabDef[0], /KANBAN_ESCALATION_SCOPE_OPTIONS/, 'KanbanEscalationScopeTab must render from KANBAN_ESCALATION_SCOPE_OPTIONS')
for (const value of ['off', 'needs_input', 'all']) {
  assert.match(
    optionsDef[0],
    new RegExp(`value:\\s*['"]${value}['"]`),
    `KANBAN_ESCALATION_SCOPE_OPTIONS must offer the '${value}' scope option`,
  )
}

// 3. The tab must be wired into the fullscreen settings nav, alongside the
//    existing Subagent Rules / Layout tabs — same pattern as those two.
const settingsFullscreenDef = source.match(/function SettingsFullscreen\([\s\S]*?\n\}\n/)
assert.ok(settingsFullscreenDef, 'SettingsFullscreen component must be defined')
assert.match(
  settingsFullscreenDef[0],
  /jsx\(KanbanEscalationScopeTab,/,
  'SettingsFullscreen must render KanbanEscalationScopeTab',
)
assert.match(
  settingsFullscreenDef[0],
  /setActiveTab\('kanban-escalation'\)/,
  'SettingsFullscreen nav must have a button that activates the kanban-escalation tab',
)

console.log('kanban-escalation-scope structural test passed')
