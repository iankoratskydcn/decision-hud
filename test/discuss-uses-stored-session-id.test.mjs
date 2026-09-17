import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Bug: handleDiscuss passed session.create's *live* session_id into
// host.openSession, which expects the *stored* session id ($selectedStoredSessionId
// / session-tile lookups are keyed by stored_session_id). Passing the live id
// means openSession can never find a matching tile/route, so
// waitForFocusedSessionHydration's surface-healthy check never passes and the
// hydration wait times out — surfacing to the user as an indefinite spinner
// after clicking Discuss. Fix: read created.stored_session_id first.
const handleDiscussBody = source.slice(
  source.indexOf('const handleDiscuss = React.useCallback('),
  source.indexOf('const handleDiscuss = React.useCallback(') + 3000,
)

assert.match(
  handleDiscussBody,
  /const sessionId = created && \(created\.stored_session_id \|\|/,
  'handleDiscuss must prefer created.stored_session_id (what host.openSession expects) over the live session_id',
)

console.log('discuss-uses-stored-session-id regression test passed')
