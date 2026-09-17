import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Bug: session.create can return before the session is registered for
// session-scoped RPCs on the gateway (a documented race in the core desktop
// app — see use-prompt-actions/utils.ts withSessionNotFoundResume and
// session-gone-latch.ts, which retry once on "session not found"/4001/4007).
// handleDiscuss called prompt.submit immediately with no retry, so it hit
// that race and its outer catch silently fell back to clipboard-copy instead
// of opening a live chat. Fix: retry prompt.submit once after a short delay
// when the failure looks like "session not found".
const handleDiscussBody = source.slice(
  source.indexOf('const handleDiscuss = React.useCallback('),
  source.indexOf('const handleDiscuss = React.useCallback(') + 4000,
)

assert.match(
  handleDiscussBody,
  /session not found/i,
  'handleDiscuss must recognize the "session not found" race on prompt.submit',
)

assert.match(
  handleDiscussBody,
  /await host\.request\('prompt\.submit'[\s\S]*?catch \(submitErr\)[\s\S]*?await host\.request\('prompt\.submit'/,
  'handleDiscuss must retry prompt.submit once after catching a session-not-found failure',
)

console.log('discuss-retries-on-session-not-found regression test passed')
