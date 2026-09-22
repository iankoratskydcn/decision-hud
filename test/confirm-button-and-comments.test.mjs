import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Owner request 1: ConfirmButton must look like a real button, not a bare
// link — it was already a semantic <button type="button">, but had no
// border, reading as a plain blue text link at a glance. Give it an
// explicit border matching the other bordered controls (Clear response,
// Defer) so it's visually unambiguous as a button.
const confirmButtonBody = source.slice(
  source.indexOf('function ConfirmButton('),
  source.indexOf('function DeferButton('),
)

assert.match(
  confirmButtonBody,
  /type:\s*'button'/,
  'ConfirmButton must remain a semantic <button type="button">, never an <a>',
)

assert.match(
  confirmButtonBody,
  /border/,
  'ConfirmButton must render a visible border so it reads as a button, not a bare link',
)

// Owner request 2: every card type must offer a shared, independent
// "Other comments" free-text field — non-exclusive (doesn't require or
// clear any selection), merged into the structured resolve payload. This
// must live in DecisionCard (outside Body) so every CARD_RENDERERS entry
// (present and future) gets it for free, same rationale as Discuss/Defer.
const decisionCardBody = source.slice(
  source.indexOf('function DecisionCard('),
  source.indexOf('function useBoardSettings('),
)

// The comments UI itself lives in a sibling OtherCommentsField component
// (immediately above DecisionCard) that DecisionCard renders — check both
// the wiring (DecisionCard) and the field's own markup together.
const otherCommentsFieldBody = source.slice(
  source.indexOf('function OtherCommentsField('),
  source.indexOf('function DecisionCard('),
)

assert.match(
  decisionCardBody,
  /jsx\(OtherCommentsField,/,
  'DecisionCard must render the shared OtherCommentsField for every card type',
)

assert.match(
  otherCommentsFieldBody,
  /Other comments/i,
  'the shared comments field must be labeled "Other comments"',
)

assert.match(
  otherCommentsFieldBody,
  /textarea/,
  'the comments field must be a textarea (free-text, not a single-line input)',
)

assert.match(
  decisionCardBody,
  /comment:\s*trimmed/,
  'the comment must be merged into the structured resolve payload under a `comment` key',
)

console.log('confirm-button-and-comments regression test passed')
