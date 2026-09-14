# Decision HUD

Cross-project Decision HUD desktop plugin for Hermes: a card-stack decision queue plus an Agent Dashboard pane, docked beside the main chat.

- **Frontend:** `plugin.js` — a single self-contained ESM file loaded at runtime by the Hermes desktop app's plugin loader (blob URL — no build step, no relative imports; see the comment block at the top of `plugin.js` for why internal components are inlined rather than split into files).
- **Backend (decisions):** `~/.hermes/plugins/decision-hud/` (SQLite-backed, driven through `hermes decision ...` CLI commands via the generic `cli.exec` RPC — the pane never touches the DB file directly).
- **Backend (agent dashboard telemetry):** `backend/` in this repo — a PostgreSQL-backed read-only HTTP service, with disposable Docker Compose integration tests. See `docs/agent-dashboard-decision-record.md` for the authority/scope decisions behind it.

## Setup for agents / contributors (read this before touching the repo)

### 1. Clone
```
gh repo clone iankoratskydcn/decision-hud
```

### 2. Frontend tests need node_modules that are NOT in package.json
`package.json` only declares a `test` script — no dependencies. The test suite (`test/*.test.mjs`, run via `node --test test/*.test.mjs` or `npm test`) imports real `react`, `react-dom`, and `jsdom` **symlinked in from a full local hermes-agent checkout**, plus a minimal hand-written `@hermes/plugin-sdk` stub. None of this ships in the repo (`node_modules/` is gitignored), so a fresh clone has failing/erroring tests until you wire it up. Full instructions, including Windows-specific junction/symlink gotchas and the exact SDK constants to stub, are in the Hermes skill `decision-hud-dev-setup` (`skill_view(name='decision-hud-dev-setup')` if you're a Hermes agent). Short version:

1. Find a local `hermes-agent` checkout that has run `npm install` (carries the app's real `node_modules/react`, `react-dom`, `jsdom`).
2. Symlink/junction those three packages into this repo's `node_modules/`.
3. Add a minimal `node_modules/@hermes/plugin-sdk/{package.json,index.js}` stub exporting exactly what `plugin.js`'s top `import` line pulls in — get the `PALETTE_AREA` / `ROUTES_AREA` / `SIDEBAR_NAV_AREA` string constants from the real SDK source (`apps/desktop/src/app/routes.ts`, `apps/desktop/src/app/command-palette/contrib.ts` in the hermes-agent checkout) rather than guessing; a wrong string breaks registration-matching tests even when the plugin code is correct.
4. `npm test` should then show all tests passing (18/18 as of Sep 2026).

### 3. Deploy for live use in the desktop app
Symlink the whole repo directory into the desktop plugin root so edits hot-reload with no copy step:
```
cmd /c mklink "%LOCALAPPDATA%\hermes\desktop-plugins\decision-hud" "<path to this repo>"
```
(macOS/Linux: `ln -s <path to this repo> "$HERMES_HOME/desktop-plugins/decision-hud"`.)
Then Command Palette → "Reload desktop plugins" to force the first load. Subsequent saves hot-reload automatically.

### 4. Backend (agent dashboard) tests
```
cd backend
uv pip install -e .   # or pip install -e ., per pyproject.toml
docker compose up -d  # disposable Postgres for integration tests
pytest
```
See `backend/pyproject.toml` for markers (`integration` tests require the Postgres container).

## Windows gotcha: CRLF breaks structural tests
Some frontend tests (`test/settings-gear.test.mjs`, `test/sidebar-order-swap.test.mjs`, etc.) read `plugin.js` as raw text and match regexes containing literal `\n`. A Windows checkout with `core.autocrlf=true` normalizes the file to CRLF, silently breaking those regexes — the test fails with a misleading message (e.g. "DecisionHudPane function must exist") even though the function is present. This repo ships a `.gitattributes` forcing LF on checkout, so a fresh clone is unaffected; if you still hit this, `git config core.autocrlf false` and re-checkout the affected file(s) (`git checkout -- plugin.js`), then verify with `file plugin.js` (should say "UTF-8 text" with no "CRLF line terminators").

## Rich decision cards
See the `decision-hud-cards` skill for the card-type taxonomy, the `card_type`/`card_payload` schema, and the workflow for pushing/rendering rich decision cards instead of plain MCQ.
