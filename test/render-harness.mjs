// Render harness for the decision-hud desktop plugin's real components —
// unlike the source-regex tests (test/*.test.mjs at the repo root), this
// actually mounts JSX with react-dom/server and can catch runtime crashes
// (undefined property reads, missing props) that a regex on the source text
// structurally cannot see. Uses the real react/react-dom from the
// hermes-agent checkout (symlinked into node_modules/) and a minimal
// @hermes/plugin-sdk stub (node_modules/@hermes/plugin-sdk/) covering
// exactly what plugin.js imports.
//
// plugin.js has no named exports (default export only, an object with
// register()), so internal components (MetricsSidebar, SettingsPopover, …)
// aren't reachable by import. Rendering those directly would require either
// changing plugin.js's export surface (out of scope for a bug fix) or
// re-parsing/eval'ing the source to pull a function out of its closure.
// Instead this harness renders through register(): it captures the `render`
// functions passed to ctx.register() for each area, which is the exact
// runtime path the desktop app itself calls — closer to a real regression
// test than reaching into internals.
import { renderToStaticMarkup } from 'react-dom/server'

import pluginModule from '../plugin.js'

/** Collect every ctx.register({...}) call site's payload, keyed by area then id. */
export function collectRegistrations() {
  const registrations = []
  const ctx = {
    register(reg) {
      registrations.push(reg)
      return () => {}
    },
    registerMany(regs) {
      for (const reg of regs) registrations.push(reg)
    },
  }
  pluginModule.register(ctx)
  return registrations
}

/** Find one registration by area + id (throws if not found — a missing
 *  registration is itself a bug this harness should surface loudly rather
 *  than silently returning undefined to a caller that then NPEs). */
export function findRegistration(registrations, area, id) {
  const found = registrations.find((r) => r.area === area && r.id === id)
  if (!found) {
    throw new Error(`no registration found for area=${area} id=${id} (found: ${registrations.map((r) => `${r.area}/${r.id}`).join(', ')})`)
  }
  return found
}

/** Render a registration's `render()` function to static HTML. Returns
 *  { html } on success, or { error } with the actual thrown Error on
 *  failure — callers decide whether a throw is expected (red-first tests)
 *  or a regression (should stay green). */
export function renderRegistration(reg) {
  try {
    const html = renderToStaticMarkup(reg.render())
    return { html, error: null }
  } catch (error) {
    return { html: null, error }
  }
}
