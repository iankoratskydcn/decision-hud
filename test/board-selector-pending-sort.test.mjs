// BoardSelector must surface pending-decision counts per board (native
// Badge, success/green variant — matches the codebase's existing
// success-tone Badge, not a bespoke color) and sort the dropdown from
// most-waiting to least. Data source: `hermes decision projects` (already
// returns {project_id, pending} for every project with >=1 pending
// decision — see db.py list_projects()), joined onto each board's own
// project_id (the same board<->project_id link
// useProjectDashboardScope/selectedBoardProjectId already rely on).
//
// Source-level structural test only (matches kanban-escalation-scope.test.mjs's
// pattern) — this repo's jsdom install is extraneous/broken
// (`npm ls jsdom` reports "extraneous", pre-existing per branch-audit
// findings), so the interactive DOM-harness tests cannot currently run here;
// don't block this feature's tests on fixing that unrelated dependency issue.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// 1. plugin.js must import the native Badge component (not invent its own
//    colored span) from @hermes/plugin-sdk.
assert.match(
  source,
  /import \{[^}]*\bBadge\b[^}]*\} from '@hermes\/plugin-sdk'/,
  'plugin.js must import the native Badge component from @hermes/plugin-sdk',
)

// 2. A helper must fetch pending-decision counts (via `hermes decision
//    projects`, the same CLI verb useDecisionQueue already calls) and index
//    them by project_id, since BoardSelector only has each board's
//    project_id to key off of.
const pendingHookDef = source.match(/function usePendingDecisionCounts\([\s\S]*?\n\}\n/)
assert.ok(pendingHookDef, 'usePendingDecisionCounts hook must be defined')
assert.match(
  pendingHookDef[0],
  /cliExec\(\['decision', 'projects'\]\)/,
  'usePendingDecisionCounts must read counts via `hermes decision projects`',
)

// 3. A pure sort helper must order boards by pending count descending
//    (ties broken stably) — kept separate from the component so it is
//    independently testable and reusable.
assert.match(source, /function sortBoardsByPending\(/, 'sortBoardsByPending helper must be defined')

// 4. BoardSelector must consume both: accept a pending-count map, sort its
//    boards through sortBoardsByPending, and render a success-variant Badge
//    per row (only when that board has pending > 0 — a board with zero
//    pending decisions must not show an empty/zero badge).
const boardSelectorDef = source.match(/function BoardSelector\([\s\S]*?\n\}\n/)
assert.ok(boardSelectorDef, 'BoardSelector component must be defined')
assert.match(boardSelectorDef[0], /sortBoardsByPending/, 'BoardSelector must sort its boards via sortBoardsByPending')
assert.match(boardSelectorDef[0], /Badge/, 'BoardSelector must render a Badge for pending counts')
assert.match(boardSelectorDef[0], /variant:\s*['"]success['"]/, "BoardSelector's pending badge must use the native success (green) variant")

// 5. sortBoardsByPending's actual behavior: extract and eval it in isolation
//    (pure function, no React/host dependency) to prove real most-to-least
//    ordering, not just its presence in source.
const fnSrc = source.match(/function sortBoardsByPending\([\s\S]*?\n\}\n/)[0]
const sortBoardsByPending = new Function(`${fnSrc}\nreturn sortBoardsByPending;`)()
const input = [
  { slug: 'default', name: 'Default' },
  { slug: 'second-brain', name: 'Second Brain' },
  { slug: 'quiet-board', name: 'Quiet Board' },
]
const pendingBySlug = { default: 1, 'second-brain': 4 } // quiet-board absent -> 0
const sorted = sortBoardsByPending(input, pendingBySlug)
assert.deepEqual(
  sorted.map((b) => b.slug),
  ['second-brain', 'default', 'quiet-board'],
  'sortBoardsByPending must order most pending first, boards with 0/missing pending last',
)

console.log('board-selector-pending-sort structural test passed')
