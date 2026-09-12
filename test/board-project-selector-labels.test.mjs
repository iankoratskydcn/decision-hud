// Uses the interactive DOM harness (test/dom-harness.mjs): asserts the two
// row-selectors visible in the pane both carry a visible label, so they no
// longer read as two unlabeled duplicate "all" controls stacked together
// (owner report from a live screenshot: "Board settings — default" toggles
// sandwiched between an unlabeled capitalized board-tab row above and an
// unlabeled lowercase "all" project-tab row below, with nothing telling the
// two apart).
import assert from 'node:assert/strict'

import { collectRegistrations, findRegistration, flush, installLocalStorageStub, mount } from './dom-harness.mjs'

installLocalStorageStub()

const regs = collectRegistrations()
const paneReg = findRegistration(regs, 'panes', 'decision-hud:pane')
const { container, errors, unmount } = mount(paneReg.render)

await flush()
await flush()

assert.deepEqual(errors, [], `mounting the pane must not throw (got: ${errors.map((e) => e.message).join(', ')})`)

const labelTexts = [...container.querySelectorAll('div')].map((d) => d.textContent)

assert.ok(labelTexts.includes('Boards'), 'BoardSelector must render a visible "Boards" label above its row of buttons')
assert.ok(labelTexts.includes('Projects'), 'ProjectSwitcher must render a visible "Projects" label above its row of buttons')

await unmount()

console.log('board-project-selector-labels (BoardSelector/ProjectSwitcher are labeled) regression test passed')
