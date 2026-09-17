import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Owner request: swap the bottom action row order to Discuss, then Defer
// (was Defer, then Discuss), and give DeferButton the same fixed height as
// the icon buttons (DiscussButton/DismissButton) so all three line up.
const decisionCardBody = source.slice(
  source.indexOf('function DecisionCard('),
  source.indexOf('function useBoardSettings('),
)

assert.match(
  decisionCardBody,
  /className:\s*'flex items-center justify-end gap-2',\s*\n\s*children:\s*\[\s*\n\s*jsx\(DiscussButton,\s*\{\s*disabled:\s*resolving,\s*onClick:\s*\(\)\s*=>\s*onDiscuss\(decision\)\s*\}\),\s*\n\s*jsx\(DeferButton,\s*\{\s*disabled:\s*resolving,\s*onClick:\s*\(\)\s*=>\s*onDefer\(decision\.id\)\s*\}\),/,
  'the bottom action row must render DiscussButton before DeferButton (owner-requested swap)',
)

// DeferButton must share the same fixed-height sizing token as IconButton
// (h-[1.9rem]) instead of its old text-driven py-1.5 sizing, so Defer and
// the icon-only Discuss button line up vertically.
const deferButtonBody = source.slice(
  source.indexOf('function DeferButton('),
  source.indexOf('// IconButton:'),
)

assert.match(
  deferButtonBody,
  /h-\[1\.9rem\]/,
  'DeferButton must use the same h-[1.9rem] fixed height as IconButton',
)

assert.doesNotMatch(
  deferButtonBody,
  /py-1\.5/,
  'DeferButton must drop its old py-1.5 text-driven sizing now that height is fixed',
)

console.log('action-row-order-and-sizing regression test passed')
