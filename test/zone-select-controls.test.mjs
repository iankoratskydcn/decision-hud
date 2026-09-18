import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')
const zone = source.match(/function ZoneSelectCard\([\s\S]*?\n\}\n/)
assert.ok(zone, 'ZoneSelectCard must be defined')

assert.match(zone[0], /type:\s*['"]button['"]/, 'zone choices must be real buttons')
assert.match(zone[0], /rounded-md/, 'zone choices must use button styling, not link styling')
assert.match(zone[0], /Clear response/, 'ZoneSelectCard must expose a clear response action')
assert.match(zone[0], /setSelectedKey\(null\)/, 'clear response must reset the selected zone')
assert.match(zone[0], /ConfirmButton/, 'ZoneSelectCard must retain a submit/confirm button')
assert.match(zone[0], /flex[^\n]*items-center[^\n]*justify-end/, 'clear and submit controls must share an action row')

console.log('zone-select button and clear-response controls test passed')
