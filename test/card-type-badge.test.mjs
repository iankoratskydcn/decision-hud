import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Owner request (variety audit, 2026-09-23): Ian has zero passive visibility
// into which card_type is rendering. CardHeader must show a badge with the
// decision's own card_type, conditional on it being set (plain MCQ pushes
// have card_type === null/undefined and must not render an empty badge).
const cardHeaderBody = source.slice(
  source.indexOf('function CardHeader('),
  source.indexOf('function CardQuestion('),
)

assert.match(
  cardHeaderBody,
  /decision\.card_type\s*\n?\s*\?\s*jsx\('span',\s*\{/,
  'CardHeader must conditionally render a badge span keyed on decision.card_type',
)

assert.match(
  cardHeaderBody,
  /children:\s*decision\.card_type,/,
  'the card_type badge must display the raw card_type string (e.g. "spider_compare")',
)

assert.match(
  cardHeaderBody,
  /:\s*null,/,
  'the badge must render null (not an empty string/undefined element) when card_type is unset',
)

console.log('card-type-badge regression test passed')
