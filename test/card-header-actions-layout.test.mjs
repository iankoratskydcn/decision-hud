import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Owner request: the Dismiss (X) button moves into the header row, on the
// same row as the project tag / urgency label, right-aligned there — not in
// the bottom action row anymore.
assert.match(
  source,
  /function CardHeader\(\{ decision, onDismiss, resolving \}\)/,
  'CardHeader must accept onDismiss/resolving so it can render the Dismiss button itself',
)

const cardHeaderBody = source.slice(
  source.indexOf('function CardHeader('),
  source.indexOf('function CardQuestion('),
)

assert.match(
  cardHeaderBody,
  /jsx\(DismissButton,\s*\{\s*disabled:\s*resolving,\s*onClick:\s*\(\)\s*=>\s*onDismiss\(decision\.id\)\s*\}\)/,
  'CardHeader must render the DismissButton inside its own JSX tree',
)

assert.match(
  source,
  /jsx\(CardHeader,\s*\{\s*decision,\s*onDismiss,\s*resolving\s*\}\)/,
  'DecisionCard must pass onDismiss/resolving down into CardHeader',
)

// The bottom action row is right-aligned (justify-end) and must NOT render
// DismissButton a second time. Its button order (Discuss/Defer) is pinned by
// action-row-order-and-sizing.test.mjs, not duplicated here.
assert.match(
  source,
  /className:\s*'flex items-center justify-end gap-2',/,
  'the bottom action row must be right-aligned (justify-end)',
)

const decisionCardBody = source.slice(
  source.indexOf('function DecisionCard('),
  source.indexOf('function useBoardSettings('),
)
assert.doesNotMatch(
  decisionCardBody,
  /jsx\(DismissButton,\s*\{\s*disabled:\s*resolving,\s*onClick:\s*\(\)\s*=>\s*onDismiss\(decision\.id\)\s*\}\),\n\s*\],\n\s*\}\),\n\s*\],\n\s*\}\)\n\}/,
  'DismissButton must not still be rendered a second time at the end of the bottom action row',
)

console.log('card-header-actions-layout regression test passed')
