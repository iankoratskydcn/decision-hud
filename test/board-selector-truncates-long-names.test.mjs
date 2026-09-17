// BoardSelector's trigger is a fixed w-40 box (BoardSettingsPanel and the
// Dispatch/Auto-decompose/Review-dispatch toggles sit to its left in the
// same flex row). A long board/project name with no truncate class forces
// the trigger to grow past w-40 despite shrink-0, overflowing the header row
// and clipping the toggles off the edge of the pane — reported live with a
// project named "Scholastic Context Engineering" ("…batch" was all that
// remained visible of "Dispatch").
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

const boardSelectorDef = source.match(/function BoardSelector\([\s\S]*?\n\}\n/)
assert.ok(boardSelectorDef, 'BoardSelector component must be defined')

assert.match(
  boardSelectorDef[0],
  /jsx\(SelectTrigger,\s*\{[\s\S]*?className:\s*['"][^'"]*\bmin-w-0\b[^'"]*['"]/,
  'BoardSelector\'s SelectTrigger must keep min-w-0 so w-40/shrink-0 can actually shrink it',
)

assert.match(
  boardSelectorDef[0],
  /jsx\(SelectValue,\s*\{[^}]*className:\s*['"][^'"]*\btruncate\b[^'"]*['"]/,
  'BoardSelector must pass a truncate className into SelectValue so long board/project names ellipsize instead of overflowing the header row',
)

console.log('board-selector-truncates-long-names regression test passed')
