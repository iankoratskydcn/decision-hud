import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Regression guard for the live bug: the settings gear's popover ("GRID
// SIZE" panel) rendered with an INVISIBLE background because
// bg-(--ui-surface-primary) and hover:bg-(--ui-surface-secondary) are not
// real theme tokens (verified against apps/desktop/src/styles.css — neither
// is defined anywhere), so both resolved to transparent. The popover's own
// text then visually overlapped whatever board-selector row sat underneath
// it in the DOM (screenshot: "GRID SIZE" bleeding into "Shattered Flames
// Client"). --ui-bg-elevated and --chrome-action-hover are real tokens
// already used elsewhere in this app for exactly this purpose (floating
// panels over content, and icon-button hover, respectively — see
// plugins/kanban/drawer.tsx and plugins/kanban/plugin.tsx).
// tokens/etc. — see the comments in SettingsPopover and the gear button for
// the story; check the actual USAGE (a Tailwind bg-(--token) class), not
// comment text (which legitimately still names the old broken tokens for
// posterity).
assert.doesNotMatch(
  source,
  /bg-\(--ui-surface-primary\)/,
  'ui-surface-primary is not a real theme token (not defined in apps/desktop/src/styles.css) — it silently resolves to transparent',
)
assert.doesNotMatch(
  source,
  /bg-\(--ui-surface-secondary\)/,
  'ui-surface-secondary is not a real theme token (not defined in apps/desktop/src/styles.css) — it silently resolves to transparent',
)

assert.match(
  source,
  /function SettingsPopover[\s\S]*?bg-\(--ui-bg-elevated\)/,
  'SettingsPopover must paint a real, opaque background (--ui-bg-elevated) so it does not let content behind it show through',
)

console.log('settings-popover-background (real theme tokens, not invisible ones) regression test passed')
