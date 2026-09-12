import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

assert.match(
  source,
  /function useDecisionQueue\(projectId\)[\s\S]*?\}, \[projectId\]\)/,
  'useDecisionQueue must memoize refresh from its projectId parameter',
)
assert.doesNotMatch(
  source,
  /function useDecisionQueue\(projectId\)[\s\S]*?\}, \[project\]\)/,
  'useDecisionQueue must not reference the undeclared project identifier',
)

console.log('useDecisionQueue dependency regression test passed')
