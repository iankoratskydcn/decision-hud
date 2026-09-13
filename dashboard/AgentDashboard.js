import * as React from 'react'
import { flushSync } from 'react-dom'
import { jsx, jsxs } from 'react/jsx-runtime'
import { host } from '@hermes/plugin-sdk'

const MAX_ROWS = 1000
const READ_MODEL_PATH = '/decision-hud/agent-dashboard'

// --- Residual integration gap ---------------------------------------------
// The new backend HTTP service (backend/agent_dashboard/service/http_app.py)
// requires an authenticated `project_id` query param and an
// `Authorization: Bearer` + token header on every request, and there is no
// existing mechanism in this plugin (or in the surrounding desktop app
// surface visible from here) that supplies a selected-project id or an actor
// token to a docked pane's `rest()` seam. Rather than fabricate a fake global
// user/session, this reads a small local settings entry
// (`decision-hud:agent-dashboard-scope` in localStorage, mirroring the
// existing SIDEBAR_SETTINGS_STORAGE_KEY pattern in plugin.js) as an explicit,
// clearly-labeled placeholder wiring point. THIS IS NOT A REAL AUTH
// MECHANISM: nothing today writes real project/token values into this key.
// An owner decision is required on where project selection and token
// issuance actually come from in production (e.g. a workspace-level
// "selected project" store plus a desktop-issued actor token via ctx/host),
// and this placeholder should be replaced by that real source once it
// exists.
const SCOPE_STORAGE_KEY = 'decision-hud:agent-dashboard-scope'

function loadDashboardScope() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SCOPE_STORAGE_KEY) : null
    if (!raw) return { projectId: null, token: null }
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return { projectId: null, token: null }
    return {
      projectId: typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : null,
      token: typeof parsed.token === 'string' && parsed.token ? parsed.token : null,
    }
  } catch {
    // best-effort — a missing/corrupt placeholder entry just means the
    // request below is sent without project_id/Authorization and the
    // backend will reject it (400/401), which the error state surfaces.
    return { projectId: null, token: null }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateSnapshot(value) {
  if (!isRecord(value) || value.schema_version !== 'dashboard-read-model.v1') {
    throw new Error('read model is unavailable')
  }
  if (!isRecord(value.scope) || !value.scope.project_id || !value.scope.project_label) {
    throw new Error('selected project scope is unavailable')
  }
  if (!isRecord(value.freshness) || !['fresh', 'stale', 'missing'].includes(value.freshness.state)) {
    throw new Error('freshness state is unavailable')
  }
  if (!Array.isArray(value.agents) || !Array.isArray(value.metrics)) {
    throw new Error('dashboard rows are unavailable')
  }
  return value
}

function boundedRows(rows) {
  return { rows: rows.slice(0, MAX_ROWS), omitted: Math.max(0, rows.length - MAX_ROWS) }
}

function displayMetric(metric) {
  if (!isRecord(metric)) return { label: 'Metric', value: 'Unavailable' }
  if (metric.state === 'unavailable' || !finiteNumber(metric.value) && typeof metric.value !== 'string') {
    return { label: metric.label || metric.key || 'Metric', value: metric.reason || 'Unavailable' }
  }
  return {
    label: metric.label || metric.key || 'Metric',
    value: `${String(metric.value)}${metric.unit ? ` ${String(metric.unit)}` : ''}`,
    window: metric.source_window,
  }
}

function statusText(snapshot) {
  if (snapshot.freshness.state === 'missing') return 'No data'
  return snapshot.freshness.state === 'stale' ? 'Stale' : 'Live'
}

function LoadingState() {
  return jsx('div', { role: 'status', children: 'Loading Agent Dashboard…' })
}

function MessageState({ children }) {
  return jsx('div', { role: 'status', children })
}

function AgentRows({ agents }) {
  const bounded = boundedRows(agents)
  return jsxs('div', {
    children: [
      jsx('div', { className: 'mb-1 font-medium', children: 'Agents' }),
      jsx('div', {
        role: 'list',
        children: bounded.rows.map((agent, index) => jsxs('div', {
          'data-agent-row': 'true',
          role: 'listitem',
          children: [
            jsx('span', { children: isRecord(agent) ? (agent.label || agent.agent_id || 'Agent') : 'Unavailable' }),
            jsx('span', { className: 'ml-2 text-(--ui-text-tertiary)', children: isRecord(agent) ? (agent.status === 'running' ? 'Active' : (agent.status || 'Unavailable')) : 'Unavailable' }),
          ],
        }, isRecord(agent) ? (agent.agent_id || index) : index)),
      }),
      bounded.omitted > 0 ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: `${bounded.omitted} agents omitted (showing ${MAX_ROWS})` }) : null,
    ],
  })
}

function MetricRows({ metrics }) {
  const bounded = boundedRows(metrics)
  return jsxs('div', {
    children: [
      jsx('div', { className: 'mb-1 font-medium', children: 'Metrics' }),
      jsx('div', {
        role: 'list',
        children: bounded.rows.map((metric, index) => {
          const item = displayMetric(metric)
          return jsxs('div', {
            'data-metric-row': 'true',
            children: [
              jsx('span', { children: item.label }),
              jsx('span', { className: 'ml-2', children: item.value }),
              item.window ? jsx('span', { className: 'ml-2 text-(--ui-text-tertiary)', children: item.window }) : null,
            ],
          }, index)
        }),
      }),
      bounded.omitted > 0 ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: `${bounded.omitted} metrics omitted (showing ${MAX_ROWS})` }) : null,
    ],
  })
}

function DashboardContent({ snapshot }) {
  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', { children: [jsx('span', { className: 'font-medium', children: 'Scope: ' }), jsx('span', { children: snapshot.scope.project_label })] }),
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: statusText(snapshot) }),
      jsx(AgentRows, { agents: snapshot.agents }),
      jsx(MetricRows, { metrics: snapshot.metrics }),
    ],
  })
}

export function AgentDashboard({ rest }) {
  const [state, setState] = React.useState({ loading: true, snapshot: null, error: null })
  React.useLayoutEffect(() => {
    let active = true
    let request
    try {
      const { projectId, token } = loadDashboardScope()
      const query = { limit: MAX_ROWS }
      if (projectId) query.project_id = projectId
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined
      request = rest(READ_MODEL_PATH, { method: 'GET', query, headers })
    } catch (error) {
      if (active) flushSync(() => setState({ loading: false, snapshot: null, error: String(error?.message || error) }))
      return () => { active = false }
    }
    Promise.resolve(request)
      .then((response) => validateSnapshot(response))
      .then((snapshot) => { if (active) flushSync(() => setState({ loading: false, snapshot, error: null })) })
      .catch((error) => { if (active) flushSync(() => setState({ loading: false, snapshot: null, error: String(error?.message || error) })) })
    return () => { active = false }
  }, [rest])

  return jsxs('section', {
    'aria-label': 'Agent Dashboard',
    className: 'flex h-full flex-col gap-3 p-3 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: 'Agent Dashboard' }),
      state.loading ? jsx(LoadingState, {}) : state.error ? jsx(MessageState, { children: `Dashboard unavailable: ${state.error}` }) : jsx(DashboardContent, { snapshot: state.snapshot }),
    ],
  })
}

export function AgentDashboardRoutePlaceholder() {
  return jsxs('div', {
    className: 'flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-(--ui-text-secondary)',
    children: [
      jsx('div', { key: 'title', className: 'font-medium', children: 'Agent Dashboard' }),
      jsx('div', { key: 'body', className: 'max-w-sm text-[0.8rem] text-(--ui-text-tertiary)', children: 'Show Agent Dashboard in the docked pane.' }),
      jsx('button', {
        key: 'reveal',
        type: 'button',
        'aria-label': 'Show Agent Dashboard',
        onClick: () => host.revealPane('decision-hud:agent-dashboard'),
        className:
          'rounded-md border border-(--ui-stroke-secondary) px-3 py-1.5 text-[0.8rem] font-medium hover:bg-(--chrome-action-hover)',
        children: 'Show Agent Dashboard',
      }),
    ],
  })
}
