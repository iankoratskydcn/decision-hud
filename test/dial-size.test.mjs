import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// RadialGaugeDisplay must accept an optional size/compact param, defaulting
// to the existing full size so ModeRadialGaugeCard stays backward compatible.
assert.match(
  source,
  /function RadialGaugeDisplay\(\{[^}]*size\s*=\s*['"]default['"][^}]*\}\)/,
  'RadialGaugeDisplay must accept a size param defaulting to "default"',
)

// The card call site (ModeRadialGaugeCard) must NOT pass a compact size —
// it should keep using the default full-size gauge.
const modeRadialGaugeCardSection = source.slice(
  source.indexOf('function ModeRadialGaugeCard'),
  source.indexOf('function MetricDial'),
)
assert.doesNotMatch(
  modeRadialGaugeCardSection,
  /size:\s*['"]compact['"]/,
  'ModeRadialGaugeCard must not shrink its gauge — only MetricDial gauges should be compact',
)

// MetricDial must pass a smaller/compact size into RadialGaugeDisplay.
const metricDialSection = source.slice(
  source.indexOf('function MetricDial'),
  source.indexOf('function MetricsSidebar'),
)
assert.match(
  metricDialSection,
  /jsx\(RadialGaugeDisplay,\s*\{[^}]*size:\s*['"]compact['"][^}]*\}\)/,
  'MetricDial must pass size: "compact" to RadialGaugeDisplay',
)

console.log('dial-size regression test passed')
