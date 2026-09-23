import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')
const cli = await readFile(resolve(here, '..', 'backend-plugin', 'cli.py'), 'utf8')

assert.match(
  cli,
  /["']kanban_completion_toasts["']\s*:\s*["']1["']/,
  'HUD settings must default Kanban completion toasts to enabled',
)
assert.match(
  source,
  /kanban_completion_toasts/,
  'Decision HUD must expose the Kanban completion toast setting',
)
assert.match(
  source,
  /Kanban Notifications/,
  'Decision HUD settings must include a Kanban Notifications tab',
)
assert.match(
  source,
  /settings-set['"],\s*'kanban_completion_toasts'/,
  'the notification toggle must persist through settings-set',
)

console.log('kanban-notification-toggle structural test passed')
