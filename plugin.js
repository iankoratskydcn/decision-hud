/**
 * Decision HUD desktop plugin — card-stack pane for the cross-project
 * decision queue (backend: ~/.hermes/plugins/decision-hud/).
 *
 * Data path: this pane never touches the SQLite file directly (desktop
 * plugins have no filesystem access). It drives the backend plugin's
 * `hermes decision ...` CLI commands through the generic `cli.exec` RPC
 * (host.request('cli.exec', { argv: [...] })), which is the standard
 * non-interactive command-exec surface already built into the gateway —
 * no core changes, no new RPC method needed.
 *
 * Layout: card stack in the center (3-5 pending decisions, oldest/highest
 * urgency first), a project switcher across the top, docked to the RIGHT
 * of the main chat pane so it sits beside a live conversation. The left
 * "switchable visualization" panel is a v1 placeholder (per the build
 * decision) — wired for a future per-project stats view.
 *
 * Rich cards (decision-hud-cards skill): a decision row can carry an
 * optional `card_type` + `card_payload` (see ~/.hermes/plugins/decision-hud/
 * db.py v2 schema) hinting which visual widget below to render instead of
 * the plain button list. `question`/`choices` always remain a complete,
 * legible fallback — DecisionCard dispatches on card_type but falls back to
 * the plain list for null/unrecognized types, so this never hard-fails on
 * older or hand-pushed decisions with no card_type set.
 */

import { cn, haptic, host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'

const PLUGIN_ID = 'decision-hud'
const POLL_MS = 4000

// F2 authorization: the desktop pane is the interactive-only resolution
// surface, so it mints ONE actor token per pane session (lazily, on first
// resolve) via `hermes decision issue-token` and holds the raw value only
// in this module's memory for the life of the pane — never written to
// disk by the pane itself (db.py's issue_actor_token() persists only the
// token's SHA-256 hash, in a 0600 file only the same OS user can read).
// Every `decision resolve` cliExec call must carry --actor-token; there is
// no fallback path that resolves without one.
let _actorTokenPromise = null

async function getActorToken() {
  if (!_actorTokenPromise) {
    _actorTokenPromise = cliExec(['decision', 'issue-token', '--actor', 'desktop-pane']).then((res) => {
      if (!res || !res.ok || !res.actor_token) {
        _actorTokenPromise = null // allow retry on next resolve attempt
        throw new Error((res && res.error) || 'failed to obtain actor token')
      }
      return res.actor_token
    }).catch((e) => {
      _actorTokenPromise = null
      throw e
    })
  }
  return _actorTokenPromise
}

async function cliExec(argv) {
  const res = await host.request('cli.exec', { argv, timeout: 30 })
  if (!res || res.blocked) {
    throw new Error((res && res.hint) || 'cli.exec blocked')
  }
  if (res.code !== 0) {
    throw new Error(`decision CLI exited ${res.code}: ${res.output || ''}`)
  }
  return parseTrailingJson(res.output || '')
}

// stdout can carry noise ahead of the JSON (e.g. a Python
// RequestsDependencyWarning from an unrelated import printed to stdout), and
// separately the gateway's cli.exec joins the child's stdout AND stderr as
// `stdout + "\n" + stderr` (tui_gateway/methods_tools.py:_joined_output) —
// Python's warnings.warn() writes to STDERR, so that same warning can land
// AFTER the JSON instead of before it. A "scan backward from the last line"
// approach can never recover from trailing noise (every suffix slice still
// ends in garbage), so instead find the first complete top-level JSON value
// by bracket-matching from the start and ignore anything that follows it —
// robust to noise on either side.
function parseTrailingJson(output) {
  const trimmed = output.trim()
  if (trimmed) {
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      // fall through to bracket-matched extraction below
    }
  }
  for (let i = 0; i < output.length; i++) {
    const ch = output[i]
    if (ch !== '{' && ch !== '[') continue
    const close = ch === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < output.length; j++) {
      const c = output[j]
      if (inString) {
        if (escape) {
          escape = false
        } else if (c === '\\') {
          escape = true
        } else if (c === '"') {
          inString = false
        }
        continue
      }
      if (c === '"') {
        inString = true
      } else if (c === ch) {
        depth++
      } else if (c === close) {
        depth--
        if (depth === 0) {
          const candidate = output.slice(i, j + 1)
          try {
            return JSON.parse(candidate)
          } catch (e) {
            break // this bracket run wasn't valid JSON; keep scanning for the next '{'/'['
          }
        }
      }
    }
  }
  throw new Error(`decision CLI returned no JSON value: ${output}`)
}

function useKanbanBoards() {
  // Kanban boards are a wholly separate concept from decision-hud "projects"
  // (see BoardSelector below) — this only lists them for the selector UI,
  // it does not join them to anything.
  const [state, setState] = React.useState({ boards: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      // Real CLI verb, confirmed via `hermes kanban boards list --help`:
      // `hermes kanban boards list --json` — returns a bare JSON array of
      // board objects (not wrapped in a `{ boards: [...] }` envelope like
      // the decision CLI's list commands).
      const boardsRes = await cliExec(['kanban', 'boards', 'list', '--json'])
      setState({ boards: Array.isArray(boardsRes) ? boardsRes : [], loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

function useDecisionQueue(projectId) {
  const [state, setState] = React.useState({ decisions: [], projects: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      const [listRes, projRes] = await Promise.all([
        cliExec(['decision', 'list', '--limit', '5', ...(projectId ? ['--project-id', projectId] : [])]),
        cliExec(['decision', 'projects']),
      ])
      setState({
        decisions: listRes.decisions || [],
        projects: projRes.projects || [],
        loading: false,
        error: null,
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [projectId])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

const URGENCY_COLOR = {
  high: 'var(--ui-danger, #e5484d)',
  normal: 'var(--ui-text-secondary)',
  low: 'var(--ui-text-tertiary)',
}

// --- Shared small primitives --------------------------------------------

// safeText: coerce any payload/decision-derived value to a renderable JSX
// child. React itself throws when handed a bare object/array as children —
// this is the single choke point every renderer below funnels scalars
// through before putting them in `children`.
function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch (e) {
    return fallback
  }
}

// safeArray: never let a non-array payload field reach .map() — every
// CARD_RENDERERS component reads its list/array fields from card_payload
// (fully-attacker/producer-controlled JSON) through this instead of a bare
// `|| []` fallback, which only covers missing/null, not wrong-type.
function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function CardHeader({ decision }) {
  return jsxs('div', {
    className: 'flex items-center justify-between text-[0.7rem]',
    children: [
      jsx('span', {
        className: 'rounded px-1.5 py-0.5 font-medium text-(--ui-text-tertiary)',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: safeText(decision.project_slug, decision.project_id),
      }),
      jsx('span', {
        style: { color: URGENCY_COLOR[decision.urgency] || URGENCY_COLOR.normal },
        children: safeText(decision.urgency),
      }),
    ],
  })
}

function CardQuestion({ decision }) {
  return jsx('div', { className: 'text-sm font-medium leading-snug', children: safeText(decision.question, '(no question text)') })
}

function ConfirmButton({ disabled, resolving, onClick, children }) {
  return jsx('button', {
    type: 'button',
    disabled: disabled || resolving,
    onClick,
    className: cn(
      'mt-1 rounded-md px-3 py-1.5 text-[0.8rem] font-medium',
      'bg-(--ui-accent)/15 text-(--ui-accent)',
      'transition-colors hover:bg-(--ui-accent) hover:text-(--ui-on-accent,#fff)',
      'disabled:opacity-40 disabled:hover:bg-(--ui-accent)/15 disabled:hover:text-(--ui-accent)'
    ),
    children: children || 'Confirm',
  })
}

function DeferButton({ disabled, onClick }) {
  return jsx('button', {
    type: 'button',
    disabled,
    onClick,
    className: cn(
      'mt-1 rounded-md px-3 py-1.5 text-[0.8rem] font-medium transition-opacity',
      'disabled:opacity-40 hover:bg-(--chrome-action-hover)'
    ),
    style: { border: '1px solid var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)' },
    children: 'Defer',
  })
}

// --- Card type components -------------------------------------------------
// Each receives (decision, onResolve, resolving) and calls
// onResolve(decisionId, plainTextChoiceSummary, structuredPayloadOrNull).

function DefaultChoiceCard({ decision, onResolve, resolving }) {
  // Plain-text fallback: also the renderer for card_type null/unrecognized,
  // and effectively for "mcq_plus_context" since a single click IS the
  // choice — the desktop pane has no free-text box (that variant is a
  // ::preview-only affordance); the plain list already satisfies "always
  // available as backup" here.
  const choices = safeArray(decision.choices)
  if (choices.length === 0) {
    return jsx('div', {
      className: 'text-[0.75rem] text-(--ui-text-tertiary)',
      children: 'No choices available for this decision — malformed decision data.',
    })
  }
  return jsx('div', {
    className: 'flex flex-col gap-1.5',
    children: choices.map((choice) =>
      jsx(
        'button',
        {
          key: safeText(choice),
          type: 'button',
          disabled: resolving,
          onClick: () => onResolve(decision.id, choice, null),
          className: cn(
            'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
            'hover:bg-(--chrome-action-hover) disabled:opacity-50'
          ),
          style: {
            border:
              choice === decision.recommended
                ? '1px solid var(--ui-accent)'
                : '1px solid var(--ui-stroke-secondary)',
          },
          children: [
            safeText(choice),
            choice === decision.recommended
              ? jsx('span', { className: 'ml-1.5 text-(--ui-text-tertiary)', children: '★' })
              : null,
          ],
        }
      )
    ),
  })
}

function QuadChoiceCard({ decision, onResolve, resolving }) {
  // Same one-click-resolves model as the default list, just laid out as a
  // 2-column grid — matches the ::preview Quad Choice card's shape
  // (both/either/one-only/neither) without needing a payload.
  const choices = safeArray(decision.choices)
  if (choices.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  return jsx('div', {
    className: 'grid grid-cols-2 gap-2',
    children: choices.map((choice) =>
      jsx('button', {
        key: safeText(choice),
        type: 'button',
        disabled: resolving,
        onClick: () => onResolve(decision.id, choice, null),
        className: cn(
          'rounded-md px-2 py-2 text-center text-[0.75rem] transition-colors',
          'hover:bg-(--chrome-action-hover) disabled:opacity-50'
        ),
        style: {
          border:
            choice === decision.recommended
              ? '1px solid var(--ui-accent)'
              : '1px solid var(--ui-stroke-secondary)',
        },
        children: safeText(choice),
      })
    ),
  })
}

function MultiSelectCard({ decision, onResolve, resolving }) {
  const choices = safeArray(decision.choices)
  const [selected, setSelected] = React.useState(() => new Set())
  const toggle = (choice) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(choice) ? next.delete(choice) : next.add(choice)
      return next
    })
  }
  if (choices.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: choices.map((choice) =>
          jsxs('button', {
            key: safeText(choice),
            type: 'button',
            disabled: resolving,
            onClick: () => toggle(choice),
            className: cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: `1px solid ${selected.has(choice) ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              jsx('span', {
                className: 'inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[0.6rem]',
                style: {
                  border: '1px solid var(--ui-stroke-secondary)',
                  background: selected.has(choice) ? 'var(--ui-accent)' : 'transparent',
                  color: 'var(--ui-on-accent, #fff)',
                },
                children: selected.has(choice) ? '✓' : '',
              }),
              safeText(choice),
            ],
          })
        ),
      }),
      jsx(ConfirmButton, {
        disabled: selected.size === 0,
        resolving,
        onClick: () => {
          const list = Array.from(selected)
          onResolve(decision.id, list.join(', '), { selected: list })
        },
        children: `Confirm (${selected.size} selected)`,
      }),
    ],
  })
}

function SequenceOrderCard({ decision, onResolve, resolving }) {
  const initialOrder = safeArray(decision.choices)
  const [order, setOrder] = React.useState(initialOrder)
  const [firstPick, setFirstPick] = React.useState(null)

  if (initialOrder.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const handleClick = (idx) => {
    if (firstPick === null) {
      setFirstPick(idx)
      return
    }
    if (firstPick === idx) {
      setFirstPick(null)
      return
    }
    setOrder((prev) => {
      const next = [...prev]
      ;[next[firstPick], next[idx]] = [next[idx], next[firstPick]]
      return next
    })
    setFirstPick(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click two rows to swap their order.',
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: order.map((item, idx) =>
          jsxs('button', {
            key: safeText(item) + '-' + idx,
            type: 'button',
            disabled: resolving,
            onClick: () => handleClick(idx),
            className: cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: `1px solid ${firstPick === idx ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              jsx('span', {
                className: 'flex h-4 w-4 items-center justify-center rounded-full text-[0.65rem] text-(--ui-text-tertiary)',
                style: { border: '1px solid var(--ui-stroke-secondary)' },
                children: String(idx + 1),
              }),
              safeText(item),
            ],
          })
        ),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, order.join(' → '), { order }),
        children: 'Confirm order',
      }),
    ],
  })
}

function AssemblePiecesCard({ decision, onResolve, resolving }) {
  // card_payload.slots: [{ key, label, options: [...] }]
  const slots = safeArray(decision.card_payload && decision.card_payload.slots)
  const [picks, setPicks] = React.useState({})
  const allPicked = slots.length > 0 && slots.every((s) => s && picks[s.key])

  if (slots.length === 0) {
    // malformed/missing payload — never dead-end, fall back to plain list
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      ...slots.map((slot, slotIdx) => {
        const options = safeArray(slot && slot.options)
        const slotKey = slot && slot.key !== undefined ? safeText(slot.key) : `slot-${slotIdx}`
        return jsxs('div', {
          key: slotKey,
          className: 'flex flex-col gap-1',
          children: [
            jsx('div', { className: 'text-[0.7rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: safeText(slot && slot.label, slotKey) }),
            jsx('div', {
              className: 'flex flex-wrap gap-1.5',
              children: options.map((opt) =>
                jsx('button', {
                  key: safeText(opt),
                  type: 'button',
                  disabled: resolving,
                  onClick: () => setPicks((prev) => ({ ...prev, [slotKey]: opt })),
                  className: 'rounded-md px-2 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
                  style: { border: `1px solid ${picks[slotKey] === opt ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                  children: safeText(opt),
                })
              ),
            }),
          ],
        })
      }),
      jsx(ConfirmButton, {
        disabled: !allPicked,
        resolving,
        onClick: () => {
          const summary = slots.map((s, i) => `${(s && s.key) || `slot-${i}`}=${picks[(s && s.key) || `slot-${i}`]}`).join(', ')
          onResolve(decision.id, summary, { picks })
        },
        children: 'Confirm assembly',
      }),
    ],
  })
}

const MATRIX_QUADRANTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function BalanceScaleCard({ decision, onResolve, resolving }) {
  // decision.choices must be exactly the 2 sides; card_payload.considerations
  // is the list of chip labels to sort between them.
  const sides = safeArray(decision.choices)
  const sideA = sides[0]
  const sideB = sides[1]
  const considerations = safeArray(decision.card_payload && decision.card_payload.considerations)
  const [placement, setPlacement] = React.useState({}) // label -> 'A' | 'B'

  if (considerations.length === 0 || sideA === undefined || sideB === undefined) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const allPlaced = considerations.every((c) => placement[c])
  const countA = considerations.filter((c) => placement[c] === 'A').length
  const countB = considerations.filter((c) => placement[c] === 'B').length

  const cycle = (label) => {
    setPlacement((prev) => ({ ...prev, [label]: prev[label] === 'A' ? 'B' : 'A' }))
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Click each item to toggle it between "${safeText(sideA)}" and "${safeText(sideB)}".`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: considerations.map((label) =>
          jsxs('button', {
            key: safeText(label),
            type: 'button',
            disabled: resolving,
            onClick: () => cycle(label),
            className: 'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: { border: `1px solid ${placement[label] ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              safeText(label),
              jsx('span', {
                className: 'text-[0.7rem] text-(--ui-text-tertiary)',
                children: placement[label] ? `→ ${placement[label] === 'A' ? safeText(sideA) : safeText(sideB)}` : '(unplaced — click to place)',
              }),
            ],
          })
        ),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPlaced ? `${safeText(sideA)}: ${countA}  ·  ${safeText(sideB)}: ${countB}` : 'Place every item to see the tally.',
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const winner = countA === countB ? 'tied' : countA > countB ? sideA : sideB
          onResolve(decision.id, `${safeText(winner)} (${countA} vs ${countB})`, {
            winner,
            tally: { [sideA]: countA, [sideB]: countB },
          })
        },
        children: 'Confirm choice',
      }),
    ],
  })
}

function WeightedAllocationCard({ decision, onResolve, resolving }) {
  // card_payload: { total, options: [{ key, label }] }
  const totalRaw = decision.card_payload && decision.card_payload.total
  const total = typeof totalRaw === 'number' && isFinite(totalRaw) ? totalRaw : 10
  const options = safeArray(decision.card_payload && decision.card_payload.options)
  const [values, setValues] = React.useState(() => Object.fromEntries(options.map((o, i) => [(o && o.key) ?? `opt-${i}`, 0])))

  if (options.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const used = Object.values(values).reduce((a, b) => a + b, 0)
  const remaining = total - used

  const step = (key, dir) => {
    setValues((prev) => {
      const next = prev[key] + dir
      if (next < 0) return prev
      if (dir > 0 && used >= total) return prev
      return { ...prev, [key]: next }
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `${remaining} point${remaining === 1 ? '' : 's'} remaining`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: options.map((opt, i) => {
          const key = (opt && opt.key) ?? `opt-${i}`
          return jsxs('div', {
            key: safeText(key),
            className: 'flex items-center justify-between rounded-md px-2.5 py-1.5',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: [
              jsx('span', { className: 'text-[0.8rem]', children: safeText(opt && opt.label, safeText(key)) }),
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('button', {
                    type: 'button',
                    disabled: resolving || values[key] <= 0,
                    onClick: () => step(key, -1),
                    className: 'flex h-5 w-5 items-center justify-center rounded disabled:opacity-30',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: '−',
                  }),
                  jsx('span', { className: 'w-4 text-center text-[0.8rem] font-medium', children: safeText(values[key], '0') }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving || remaining <= 0,
                    onClick: () => step(key, 1),
                    className: 'flex h-5 w-5 items-center justify-center rounded disabled:opacity-30',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: '+',
                  }),
                ],
              }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: remaining !== 0,
        resolving,
        onClick: () => {
          const summary = options.map((o, i) => `${(o && o.key) ?? `opt-${i}`}=${values[(o && o.key) ?? `opt-${i}`]}`).join(', ')
          onResolve(decision.id, summary, { allocation: values })
        },
        children: 'Confirm allocation',
      }),
    ],
  })
}

function ScalarSliderCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default, unit }
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const min = typeof p.min === 'number' ? p.min : 0
  const max = typeof p.max === 'number' ? p.max : 100
  const step = typeof p.step === 'number' ? p.step : 1
  const unit = safeText(p.unit, '')
  const [value, setValue] = React.useState(typeof p.default === 'number' ? p.default : min)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-center text-lg font-semibold', style: { color: 'var(--ui-accent)' }, children: `${value}${unit}` }),
      jsx('input', {
        type: 'range',
        min,
        max,
        step,
        value,
        disabled: resolving,
        onChange: (e) => setValue(Number(e.target.value)),
        className: 'w-full',
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, `${value}${unit}`, { value }),
        children: `Confirm ${value}${unit}`,
      }),
    ],
  })
}

function RangeSliderCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default_low, default_high, unit }
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const min = typeof p.min === 'number' ? p.min : 0
  const max = typeof p.max === 'number' ? p.max : 1000
  const step = typeof p.step === 'number' ? p.step : 10
  const unit = safeText(p.unit, '')
  const [lo, setLo] = React.useState(typeof p.default_low === 'number' ? p.default_low : min)
  const [hi, setHi] = React.useState(typeof p.default_high === 'number' ? p.default_high : max)

  const loClamped = Math.min(lo, hi)
  const hiClamped = Math.max(lo, hi)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-center text-sm font-semibold',
        style: { color: 'var(--ui-accent)' },
        children: `${loClamped}${unit} – ${hiClamped}${unit}`,
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('input', { type: 'range', min, max, step, value: lo, disabled: resolving, onChange: (e) => setLo(Number(e.target.value)), className: 'w-full' }),
          jsx('input', { type: 'range', min, max, step, value: hi, disabled: resolving, onChange: (e) => setHi(Number(e.target.value)), className: 'w-full' }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, `${loClamped}${unit}-${hiClamped}${unit}`, { low: loClamped, high: hiClamped }),
        children: `Confirm ${loClamped}${unit} – ${hiClamped}${unit}`,
      }),
    ],
  })
}

function AnchorAdjustCard({ decision, onResolve, resolving }) {
  // card_payload.fields: [{ key, label, default, options: [...] }]
  const fields = safeArray(decision.card_payload && decision.card_payload.fields)
  const [values, setValues] = React.useState(() => Object.fromEntries(fields.map((f, i) => [(f && f.key) ?? `field-${i}`, f && f.default])))
  const [open, setOpen] = React.useState({})

  if (fields.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const overriddenCount = fields.filter((f, i) => values[(f && f.key) ?? `field-${i}`] !== (f && f.default)).length

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children:
          overriddenCount === 0
            ? `All ${fields.length} fields at recommended defaults — Confirm works now.`
            : `${overriddenCount}/${fields.length} field(s) overridden.`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: fields.map((f, i) => {
          const key = (f && f.key) ?? `field-${i}`
          const options = safeArray(f && f.options)
          const overridden = values[key] !== (f && f.default)
          return jsxs('div', {
            key: safeText(key),
            className: 'rounded-md px-2.5 py-1.5',
            style: { border: `1px solid ${overridden ? 'var(--ui-text-tertiary)' : 'var(--ui-accent)'}` },
            children: [
              jsxs('button', {
                type: 'button',
                disabled: resolving,
                onClick: () => setOpen((prev) => ({ ...prev, [key]: !prev[key] })),
                className: 'flex w-full items-center justify-between text-left text-[0.8rem]',
                children: [
                  jsxs('span', { children: [`${safeText(f && f.label, safeText(key))} — `, jsx('b', { children: safeText(values[key]) })] }),
                  jsx('span', {
                    className: 'text-[0.65rem]',
                    style: { color: overridden ? 'var(--ui-text-tertiary)' : 'var(--ui-accent)' },
                    children: overridden ? 'Overridden' : 'Recommended',
                  }),
                ],
              }),
              open[key]
                ? jsx('div', {
                    className: 'mt-1.5 flex flex-wrap gap-1 border-t pt-1.5',
                    style: { borderColor: 'var(--ui-stroke-secondary)' },
                    children: options.map((opt) =>
                      jsx('button', {
                        key: safeText(opt),
                        type: 'button',
                        disabled: resolving,
                        onClick: () => setValues((prev) => ({ ...prev, [key]: opt })),
                        className: 'rounded px-1.5 py-0.5 text-[0.7rem] transition-colors hover:bg-(--chrome-action-hover)',
                        style: { border: `1px solid ${values[key] === opt ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                        children: safeText(opt),
                      })
                    ),
                  })
                : null,
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const summary = fields.map((f, i) => {
            const key = (f && f.key) ?? `field-${i}`
            return `${key}=${values[key]}`
          }).join(', ')
          onResolve(decision.id, summary, { values })
        },
        children: 'Confirm config',
      }),
    ],
  })
}

function Matrix2x2Card({ decision, onResolve, resolving }) {
  // card_payload: { x_axis_label, y_axis_label, items: [{ key, label }] }
  const payload = decision.card_payload || {}
  const xLabel = payload.x_axis_label
  const yLabel = payload.y_axis_label
  const items = safeArray(payload.items)
  const [placements, setPlacements] = React.useState({}) // item_key -> quadrant

  // Guard: missing axis labels or malformed items array -> plain fallback,
  // never crash on an attacker/producer-controlled payload.
  if (
    typeof xLabel !== 'string' || xLabel.trim() === '' ||
    typeof yLabel !== 'string' || yLabel.trim() === '' ||
    items.length === 0 ||
    !items.every((it) => it && typeof it === 'object' && it.key !== undefined && it.key !== null && it.key !== '')
  ) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const itemKeys = items.map((it) => safeText(it.key))
  const allPlaced = itemKeys.length > 0 && itemKeys.every((k) => placements[k])

  const place = (key, quadrant) => {
    setPlacements((prev) => ({ ...prev, [key]: quadrant }))
  }

  const unplaced = items.filter((it) => !placements[safeText(it.key)])

  const quadrantCell = (quadrant, cornerLabel) => {
    const inQuadrant = items.filter((it) => placements[safeText(it.key)] === quadrant)
    return jsxs('div', {
      key: quadrant,
      className: 'flex min-h-[84px] flex-col gap-1 rounded-md p-2',
      style: { border: '1px solid var(--ui-stroke-secondary)' },
      children: [
        jsx('div', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: cornerLabel }),
        jsx('div', {
          className: 'flex flex-wrap gap-1',
          children: inQuadrant.map((it) =>
            jsx('button', {
              key: safeText(it.key),
              type: 'button',
              disabled: resolving,
              onClick: () => place(safeText(it.key), null),
              className: 'rounded-md px-1.5 py-0.5 text-[0.7rem] transition-colors hover:bg-(--chrome-action-hover)',
              style: { border: '1px solid var(--ui-accent)' },
              children: safeText(it.label, safeText(it.key)),
            })
          ),
        }),
      ],
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Click an unplaced item, then click the quadrant it belongs in. Axes: "${safeText(xLabel)}" (x) vs "${safeText(yLabel)}" (y).`,
      }),
      jsx('div', {
        className: 'grid grid-cols-2 gap-1.5',
        children: [
          quadrantCell('top-left', 'Top-Left'),
          quadrantCell('top-right', 'Top-Right'),
          quadrantCell('bottom-left', 'Bottom-Left'),
          quadrantCell('bottom-right', 'Bottom-Right'),
        ],
      }),
      unplaced.length > 0
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx('div', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Unplaced items — click a quadrant button below each' }),
              jsx('div', {
                className: 'flex flex-col gap-1',
                children: unplaced.map((it) => {
                  const key = safeText(it.key)
                  return jsxs('div', {
                    key,
                    className: 'flex items-center justify-between gap-2 rounded-md px-2 py-1',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: [
                      jsx('span', { className: 'text-[0.78rem]', children: safeText(it.label, key) }),
                      jsx('div', {
                        className: 'flex flex-wrap gap-1',
                        children: MATRIX_QUADRANTS.map((q) =>
                          jsx('button', {
                            key: q,
                            type: 'button',
                            disabled: resolving,
                            onClick: () => place(key, q),
                            className: 'rounded-md px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                            style: { border: '1px solid var(--ui-stroke-secondary)' },
                            children: q,
                          })
                        ),
                      }),
                    ],
                  })
                }),
              }),
            ],
          })
        : null,
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it) => `${safeText(it.label, safeText(it.key))}=${placements[safeText(it.key)]}`)
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

function SortToBinCard({ decision, onResolve, resolving }) {
  // card_payload: { items: [{ key, label }], bins: [{ key, label }] }
  // Click-to-place (not HTML5 drag-and-drop): this codebase already
  // resolved the same tension in BalanceScaleCard (chips onto sides) by
  // using click-to-cycle rather than porting the prototype's native
  // drag/drop — click targets are simpler to reach with keyboard/assistive
  // tech and there is zero existing native-DnD precedent anywhere else in
  // plugin.js to match. Interaction: click an item to select it, then
  // click a bin to place the selected item there; click a placed item
  // again to re-select and move it.
  const items = safeArray(decision.card_payload && decision.card_payload.items)
  const bins = safeArray(decision.card_payload && decision.card_payload.bins)
  const [placements, setPlacements] = React.useState({})
  const [selectedItem, setSelectedItem] = React.useState(null)

  // Malformed payload guard: need at least one item and 2-3 bins, else
  // fall back to the plain choice list rather than risk a broken render.
  if (items.length === 0 || bins.length < 2 || bins.length > 3) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const itemKeyOf = (it, i) => (it && it.key !== undefined ? safeText(it.key) : `item-${i}`)
  const binKeyOf = (bin, i) => (bin && bin.key !== undefined ? safeText(bin.key) : `bin-${i}`)
  const allPlaced = items.every((it, i) => placements[itemKeyOf(it, i)])

  const place = (itemKey, binKey) => {
    setPlacements((prev) => ({ ...prev, [itemKey]: binKey }))
    setSelectedItem(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: selectedItem
          ? 'Click a bin below to place the selected item.'
          : 'Click an item, then click the bin to place it in.',
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1.5 rounded-md p-2',
        style: { border: '1px dashed var(--ui-stroke-secondary)' },
        children: items.map((it, i) => {
          const key = itemKeyOf(it, i)
          const placed = placements[key]
          return jsx('button', {
            key,
            type: 'button',
            disabled: resolving,
            onClick: () => setSelectedItem(selectedItem === key ? null : key),
            className: 'rounded-full px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: {
              border: `1px solid ${selectedItem === key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
              opacity: placed ? 0.5 : 1,
            },
            children: safeText(it && it.label, key),
          })
        }),
      }),
      jsx('div', {
        className: 'grid gap-1.5',
        style: { gridTemplateColumns: `repeat(${bins.length}, minmax(0,1fr))` },
        children: bins.map((bin, bi) => {
          const binKey = binKeyOf(bin, bi)
          const binItems = items.filter((it, i) => placements[itemKeyOf(it, i)] === binKey)
          return jsxs('div', {
            key: binKey,
            className: 'flex min-h-16 flex-col gap-1 rounded-md p-1.5 text-left',
            style: { border: `1px solid ${selectedItem ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            onClick: () => {
              if (selectedItem) place(selectedItem, binKey)
            },
            children: [
              jsx('div', {
                className: 'text-center text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
                children: safeText(bin && bin.label, binKey),
              }),
              ...binItems.map((it, i) =>
                jsx('div', {
                  key: itemKeyOf(it, i),
                  className: 'rounded-full px-2 py-0.5 text-center text-[0.7rem]',
                  style: { border: '1px solid var(--ui-stroke-secondary)' },
                  children: safeText(it && it.label),
                })
              ),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it, i) => {
              const key = itemKeyOf(it, i)
              return `${safeText(it && it.label, key)}→${safeText(placements[key])}`
            })
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

function ZoneSelectCard({ decision, onResolve, resolving }) {
  // card_payload.zones: [{ key, label, description? }] — quantized/few
  // discrete levels, exclusive choice. Click target only, never drag (see
  // decision-hud-cards skill: gauges/zones are click targets, not drag).
  const zones = safeArray(decision.card_payload && decision.card_payload.zones)
  const [selectedKey, setSelectedKey] = React.useState(null)

  // Malformed/missing payload, or fewer than 2 zones (nothing meaningful to
  // choose between) — never dead-end, fall back to the plain choice list.
  if (zones.length < 2) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const selectedZone = zones.find((z) => z && safeText(z.key) === selectedKey)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex overflow-hidden rounded-md',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: zones.map((zone, idx) => {
          const key = zone && zone.key !== undefined ? safeText(zone.key) : `zone-${idx}`
          const isSelected = selectedKey === key
          return jsx('button', {
            key,
            type: 'button',
            disabled: resolving,
            onClick: () => setSelectedKey(key),
            title: safeText(zone && zone.description, ''),
            className: cn(
              'flex-1 px-2 py-2 text-center text-[0.75rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: {
              borderLeft: idx === 0 ? 'none' : '1px solid var(--ui-stroke-secondary)',
              background: isSelected ? 'var(--ui-accent)/15' : 'transparent',
              color: isSelected ? 'var(--ui-accent)' : undefined,
              fontWeight: isSelected ? 600 : 400,
            },
            children: safeText(zone && zone.label, key),
          })
        }),
      }),
      selectedZone && selectedZone.description
        ? jsx('div', {
            className: 'text-[0.7rem] text-(--ui-text-tertiary)',
            children: safeText(selectedZone.description),
          })
        : null,
      jsx(ConfirmButton, {
        disabled: selectedKey === null,
        resolving,
        onClick: () => {
          const label = safeText(selectedZone && selectedZone.label, selectedKey)
          onResolve(decision.id, label, { selected_key: selectedKey, summary: label })
        },
        children: selectedKey === null ? 'Select a zone' : `Confirm "${safeText(selectedZone && selectedZone.label, selectedKey)}"`,
      }),
    ],
  })
}

const STACKED_BAR_COLORS = ['var(--ui-accent)', 'var(--ui-warning, #f5a623)', 'var(--ui-text-tertiary)']

function StackedBarSplitCard({ decision, onResolve, resolving }) {
  // card_payload: { segments: [{ key, label }, { key, label }, { key, label }] }
  // exactly 3 segments required — the bar geometry (2 dividers) only makes
  // sense for exactly 3 regions, so any other count falls back to the
  // plain choice list rather than guessing a layout.
  const segments = safeArray(decision.card_payload && decision.card_payload.segments)
  // boundaries[0] = divider between segment 0/1 (%), boundaries[1] = divider
  // between segment 1/2 (%). Percentages derive from these two numbers by
  // construction: seg0 = b0, seg1 = b1-b0, seg2 = 100-b1 — they always sum
  // to 100 with no separate validation step needed.
  const [boundaries, setBoundaries] = React.useState([33, 67])
  const barRef = React.useRef(null)
  const dragRef = React.useRef(null) // which divider index is being dragged

  if (segments.length !== 3) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const keys = segments.map((s, i) => (s && s.key) ?? `seg-${i}`)
  const labels = segments.map((s, i) => safeText(s && s.label, safeText(keys[i])))

  const pct0 = Math.round(boundaries[0])
  const pct1 = Math.round(boundaries[1] - boundaries[0])
  const pct2 = 100 - pct0 - pct1 // remainder absorbs rounding so the three always sum to exactly 100

  const percentages = [pct0, pct1, pct2]

  const clientXToPct = (clientX) => {
    const rect = barRef.current ? barRef.current.getBoundingClientRect() : null
    if (!rect || rect.width === 0) return 0
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
  }

  const moveDivider = (idx, rawPct) => {
    setBoundaries((prev) => {
      const next = [...prev]
      if (idx === 0) {
        // divider 0 can only trade percentage with segment 0 (left of it)
        // and segment 1 (between it and divider 1) — clamp so it never
        // crosses 0 or divider 1.
        next[0] = Math.min(Math.max(rawPct, 0), prev[1])
      } else {
        // divider 1 can only trade percentage between segment 1 and
        // segment 2 — clamp so it never crosses divider 0 or 100.
        next[1] = Math.max(Math.min(rawPct, 100), prev[0])
      }
      return next
    })
  }

  const onPointerDown = (idx) => (e) => {
    if (resolving) return
    e.preventDefault()
    dragRef.current = idx
    const onPointerMove = (moveEvent) => {
      if (dragRef.current === null) return
      moveDivider(dragRef.current, clientXToPct(moveEvent.clientX))
    }
    const onPointerUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const widths = [`${pct0}%`, `${pct1}%`, `${pct2}%`]

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex items-center justify-between text-[0.7rem] text-(--ui-text-tertiary)',
        children: labels.map((label, i) =>
          jsxs('span', { key: safeText(keys[i]), children: [label, ': ', jsx('b', { children: `${percentages[i]}%` })] })
        ),
      }),
      jsxs('div', {
        ref: barRef,
        className: 'relative flex h-8 w-full overflow-hidden rounded-md',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: [
          widths.map((w, i) =>
            jsx('div', {
              key: safeText(keys[i]),
              style: { width: w, backgroundColor: STACKED_BAR_COLORS[i % STACKED_BAR_COLORS.length] },
              className: 'h-full transition-[width] duration-75',
            })
          ),
          // divider handles, positioned via CSS percentage left offset so
          // dragging one only ever adjusts the boundary array (and thus
          // the two adjacent segments), never the third.
          [0, 1].map((idx) =>
            jsx('div', {
              key: `handle-${idx}`,
              onPointerDown: onPointerDown(idx),
              className: 'absolute top-0 h-full w-2 cursor-ew-resize touch-none',
              style: {
                left: `calc(${boundaries[idx]}% - 4px)`,
                backgroundColor: 'var(--ui-text-primary, #fff)',
                opacity: resolving ? 0.3 : 0.85,
              },
            })
          ),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const percentagesObj = Object.fromEntries(keys.map((k, i) => [k, percentages[i]]))
          const summary = labels.map((label, i) => `${label}=${percentages[i]}%`).join(', ')
          onResolve(decision.id, summary, { percentages: percentagesObj })
        },
        children: 'Confirm split',
      }),
    ],
  })
}

function ConstrainedBudgetSplitCard({ decision, onResolve, resolving }) {
  // card_payload: { total, categories: [{ key, label, min, max, default }] }
  // Distinct from WeightedAllocationCard: N independent range sliders (not
  // +/- steppers) that CAN be dragged past the point of exceeding the total —
  // there is no hard per-step gate. A live status banner reports
  // balanced/over/under as sliders move, and only an exact balance enables
  // Confirm.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const totalRaw = p.total
  const total = typeof totalRaw === 'number' && isFinite(totalRaw) ? totalRaw : null
  const categories = safeArray(p.categories)

  if (total === null || categories.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const catMeta = categories.map((c, i) => {
    const key = (c && c.key) ?? `cat-${i}`
    const label = safeText(c && c.label, safeText(key))
    const min = typeof (c && c.min) === 'number' ? c.min : 0
    const max = typeof (c && c.max) === 'number' ? c.max : total
    const def = typeof (c && c.default) === 'number' ? c.default : min
    return { key, label, min, max, default: def }
  })

  const [values, setValues] = React.useState(() => Object.fromEntries(catMeta.map((c) => [c.key, c.default])))

  const sum = catMeta.reduce((a, c) => a + (values[c.key] ?? 0), 0)
  const diff = total - sum
  // status: 'balanced' | 'over' | 'under' — purely descriptive, never blocks
  // slider movement; only gates the Confirm button below.
  const status = diff === 0 ? 'balanced' : diff < 0 ? 'over' : 'under'
  const statusColor = status === 'balanced' ? 'var(--ui-accent)' : status === 'over' ? 'var(--ui-danger, #e05252)' : 'var(--ui-text-tertiary)'
  const statusText =
    status === 'balanced'
      ? `Balanced — ${sum} / ${total}`
      : status === 'over'
        ? `Over by ${Math.abs(diff)} — ${sum} / ${total}`
        : `Under by ${diff} — ${sum} / ${total}`

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }))

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'rounded-md px-2.5 py-1.5 text-center text-[0.75rem] font-medium',
        style: { border: `1px solid ${statusColor}`, color: statusColor },
        children: statusText,
      }),
      jsx('div', {
        className: 'flex flex-col gap-2',
        children: catMeta.map((c) => {
          return jsxs('div', {
            key: safeText(c.key),
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.8rem]',
                children: [
                  jsx('span', { children: c.label }),
                  jsx('span', { className: 'font-medium', children: safeText(values[c.key], '0') }),
                ],
              }),
              jsx('input', {
                type: 'range',
                min: c.min,
                max: c.max,
                value: values[c.key] ?? c.min,
                disabled: resolving,
                onChange: (e) => setValue(c.key, Number(e.target.value)),
                className: 'w-full',
              }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: status !== 'balanced',
        resolving,
        onClick: () => {
          const summary = catMeta.map((c) => `${c.label}=${values[c.key]}`).join(', ') + ` (total ${sum}/${total})`
          onResolve(decision.id, summary, { allocations: values })
        },
        children: 'Confirm split',
      }),
    ],
  })
}

function ConfidenceRatingCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default, unit, confidence_levels: [{ key, label }] }
  //
  // Two independent axes, BOTH required before Confirm enables:
  //   1. value  — a point on a numeric continuum (slider, like ScalarSliderCard)
  //   2. confidence_level_key — a discrete certainty band (button group)
  //
  // UI choice: the certainty axis is a discrete button group, not a second
  // slider. Two overlapping range inputs stacked in one card read as "pick
  // two points on the same scale" (like RangeSliderCard's low/high), which
  // is the wrong mental model here — confidence is categorical judgment
  // (Low/Medium/High), not a second continuous quantity, and a small
  // button group makes "you haven't picked one yet" visually unambiguous
  // (no selection highlighted) in a way an untouched slider thumb cannot.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const hasBounds = typeof p.min === 'number' && typeof p.max === 'number'
  const levels = safeArray(p.confidence_levels).filter(
    (l) => l && typeof l === 'object' && !Array.isArray(l) && (typeof l.key === 'string' || typeof l.key === 'number')
  )

  // Malformed/missing payload -> fall back to the plain choice list rather
  // than rendering a broken slider or an empty/unusable button group.
  if (!hasBounds || levels.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const min = p.min
  const max = p.max
  const step = typeof p.step === 'number' ? p.step : 1
  const unit = safeText(p.unit, '')
  const defaultValue = typeof p.default === 'number' ? p.default : min

  const [value, setValue] = React.useState(defaultValue)
  // Both axes require an explicit user interaction, not just the default,
  // before Confirm enables. A slider always has *some* numeric value (its
  // default), so "has a value" can't gate Confirm the way it does for
  // confidence_level_key (which starts genuinely unset); we track touch
  // explicitly so a payload's default point can't silently pass as the
  // user's considered estimate.
  const [valueTouched, setValueTouched] = React.useState(false)
  const [levelKey, setLevelKey] = React.useState(null)

  const canConfirm = valueTouched && levelKey !== null

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsx('div', {
            className: 'text-center text-lg font-semibold',
            style: { color: 'var(--ui-accent)' },
            children: `${value}${unit}`,
          }),
          jsx('input', {
            type: 'range',
            min,
            max,
            step,
            value,
            disabled: resolving,
            onChange: (e) => {
              setValue(Number(e.target.value))
              setValueTouched(true)
            },
            className: 'w-full',
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'Confidence' }),
          jsx('div', {
            className: 'flex flex-wrap gap-1.5',
            children: levels.map((l, i) => {
              const key = String(l.key)
              const selected = levelKey === key
              return jsx('button', {
                key,
                type: 'button',
                disabled: resolving,
                onClick: () => setLevelKey(key),
                className: 'rounded-md px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
                style: {
                  border: `1px solid ${selected ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                  color: selected ? 'var(--ui-accent)' : undefined,
                  fontWeight: selected ? 600 : 400,
                },
                children: safeText(l.label, key),
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: !canConfirm,
        resolving,
        onClick: () => {
          const level = levels.find((l) => String(l.key) === levelKey)
          const levelLabel = safeText(level && level.label, levelKey)
          const summary = `${value}${unit} (${levelLabel} confidence)`
          onResolve(decision.id, summary, { value, confidence_level_key: levelKey })
        },
        children: canConfirm ? `Confirm ${value}${unit}` : 'Set value and confidence',
      }),
    ],
  })
}

function WireMatchCard({ decision, onResolve, resolving }) {
  // card_payload: { left: [{ key, label }], right: [{ key, label }] } —
  // click-click 1:1 pairing between two node columns (e.g. services ->
  // owning teams). Ported from decision_hud_prototype.html's drag-style
  // Wire Match card, but reworked as click-then-click (matching this
  // codebase's SequenceOrderCard/BalanceScaleCard idiom of click-based
  // interaction rather than literal HTML5 drag events) with SVG cubic
  // paths drawn between the DOM boxes of paired nodes.
  const payload = decision.card_payload
  const left = safeArray(payload && payload.left)
  const right = safeArray(payload && payload.right)

  const [selectedLeft, setSelectedLeft] = React.useState(null)
  const [links, setLinks] = React.useState({}) // left_key -> right_key
  const [paths, setPaths] = React.useState([])
  const wrapRef = React.useRef(null)
  const leftRefs = React.useRef({})
  const rightRefs = React.useRef({})

  const leftKeyOf = (item, i) => (item && item.key !== undefined && item.key !== null ? safeText(item.key) : `left-${i}`)
  const rightKeyOf = (item, i) => (item && item.key !== undefined && item.key !== null ? safeText(item.key) : `right-${i}`)

  const recalc = React.useCallback(() => {
    if (!wrapRef.current) return
    const wrapRect = wrapRef.current.getBoundingClientRect()
    const next = []
    for (const [lk, rk] of Object.entries(links)) {
      const ln = leftRefs.current[lk]
      const rn = rightRefs.current[rk]
      if (!ln || !rn) continue
      const lr = ln.getBoundingClientRect()
      const rr = rn.getBoundingClientRect()
      const x1 = lr.right - wrapRect.left
      const y1 = lr.top - wrapRect.top + lr.height / 2
      const x2 = rr.left - wrapRect.left
      const y2 = rr.top - wrapRect.top + rr.height / 2
      const mx = (x1 + x2) / 2
      next.push(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`)
    }
    setPaths(next)
  }, [links])

  React.useEffect(() => {
    recalc()
    if (typeof window === 'undefined') return undefined
    window.addEventListener('resize', recalc)
    return () => window.removeEventListener('resize', recalc)
  }, [recalc])

  if (left.length === 0 || right.length === 0) {
    // malformed/missing payload (absent, non-array, or empty either side)
    // — never dead-end, fall back to the plain choice list.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const allLinked = left.every((item, i) => links[leftKeyOf(item, i)] !== undefined)

  const handleLeftClick = (key) => {
    setSelectedLeft((prev) => (prev === key ? null : key))
  }

  const handleRightClick = (key) => {
    if (!selectedLeft) return
    setLinks((prev) => ({ ...prev, [selectedLeft]: key }))
    setSelectedLeft(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click an item on the left, then its match on the right. All items must be wired before confirming.',
      }),
      jsxs('div', {
        ref: wrapRef,
        className: 'relative flex items-stretch justify-between gap-8',
        children: [
          jsx('svg', {
            className: 'pointer-events-none absolute inset-0 h-full w-full overflow-visible',
            children: paths.map((d, i) =>
              jsx('path', { key: i, d, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2 })
            ),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: left.map((item, i) => {
              const key = leftKeyOf(item, i)
              const done = links[key] !== undefined
              return jsx('button', {
                key,
                type: 'button',
                ref: (el) => { leftRefs.current[key] = el },
                disabled: resolving,
                onClick: () => handleLeftClick(key),
                className: cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover) disabled:opacity-50'
                ),
                style: {
                  border: `1px solid ${selectedLeft === key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                  opacity: done ? 0.6 : 1,
                },
                children: [safeText(item && item.label, key), done ? jsx('span', { className: 'ml-1.5 text-(--ui-text-tertiary)', children: '●' }) : null],
              })
            }),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: right.map((item, i) => {
              const key = rightKeyOf(item, i)
              return jsx('button', {
                key,
                type: 'button',
                ref: (el) => { rightRefs.current[key] = el },
                disabled: resolving,
                onClick: () => handleRightClick(key),
                className: cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover) disabled:opacity-50'
                ),
                style: { border: '1px solid var(--ui-stroke-secondary)' },
                children: safeText(item && item.label, key),
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: !allLinked,
        resolving,
        onClick: () => {
          const pairs = left.map((item, i) => {
            const leftKey = leftKeyOf(item, i)
            return { left_key: leftKey, right_key: links[leftKey] }
          })
          const summary = pairs.map((p) => `${p.left_key}→${p.right_key}`).join(', ')
          onResolve(decision.id, summary, { pairs })
        },
        children: 'Confirm mapping',
      }),
    ],
  })
}

function PairwiseDuelCard({ decision, onResolve, resolving }) {
  const rawOptions = safeArray(decision.card_payload && decision.card_payload.options)
  // Coerce + validate: every entry needs at least a usable key; label
  // falls back to the key so a payload with keys-only still renders.
  const seeds = rawOptions
    .map((o, i) => {
      if (!o || typeof o !== 'object') return null
      const key = o.key !== undefined && o.key !== null && o.key !== '' ? safeText(o.key) : null
      if (key === null) return null
      return { key, label: safeText(o.label, key) }
    })
    .filter(Boolean)

  // React hooks must run unconditionally, so seed the reducer-ish state
  // before checking validity — the invalid-payload branch below simply
  // never touches `state`.
  const [state, setState] = React.useState(() => pairwiseDuelInitialState(seeds))

  React.useEffect(() => {
    if (seeds.length < PAIRWISE_DUEL_MIN_OPTIONS) return
    if (state.champion) return
    // Odd contestant left over in this round with no opponent -> bye,
    // advance automatically without waiting for a click.
    if (state.queue.length - state.pairIndex === 1) {
      setState((prev) => pairwiseDuelApplyBye(prev))
    }
  }, [state, seeds.length])

  if (seeds.length < PAIRWISE_DUEL_MIN_OPTIONS) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  if (state.champion) {
    return jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx('div', {
          className: 'text-[0.7rem] text-(--ui-text-tertiary)',
          children: `Champion of ${seeds.length} — ${state.log.length} round result(s) below.`,
        }),
        jsx('div', {
          className: 'rounded-md px-2.5 py-2 text-center text-[0.9rem] font-semibold',
          style: { border: '1px solid var(--ui-accent)', color: 'var(--ui-accent)' },
          children: safeText(state.champion.label),
        }),
        jsx('div', {
          className: 'flex flex-col gap-1 text-[0.7rem] text-(--ui-text-tertiary)',
          children: state.log.map((entry, i) =>
            jsx('div', {
              key: `${entry.round}-${i}`,
              children: entry.bye
                ? `Round ${entry.round}: ${entry.winner_key} — bye`
                : `Round ${entry.round}: ${entry.winner_key} beat ${entry.loser_key}`,
            })
          ),
        }),
        jsx(ConfirmButton, {
          disabled: false,
          resolving,
          onClick: () =>
            onResolve(decision.id, safeText(state.champion.label), {
              champion_key: state.champion.key,
              bracket_log: state.log,
            }),
          children: 'Confirm champion',
        }),
      ],
    })
  }

  const a = state.queue[state.pairIndex]
  const b = state.queue[state.pairIndex + 1]

  if (!a || !b) {
    // Transient state between an auto-applied bye and the next render —
    // the useEffect above resolves this on the next tick.
    return jsx('div', {
      className: 'text-[0.75rem] text-(--ui-text-tertiary)',
      children: 'Advancing bye…',
    })
  }

  const remaining = state.queue.length - state.pairIndex
  const totalRemaining = remaining + state.nextRound.length

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Round ${state.round} — ${totalRemaining} still standing. Click the winner.`,
      }),
      jsx('div', {
        className: 'grid grid-cols-2 gap-2',
        children: [a, b].map((seed, idx) =>
          jsx('button', {
            key: seed.key,
            type: 'button',
            disabled: resolving,
            onClick: () => setState((prev) => pairwiseDuelApplyWin(prev, idx)),
            className: cn(
              'rounded-md px-2 py-3 text-center text-[0.8rem] font-medium transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: safeText(seed.label),
          })
        ),
      }),
    ],
  })
}

function spiderPolygonPoints(values, cx, cy, r) {
  // values: array of 0..1 radial weights, one per axis, in axis order.
  // Regular N-gon vertex placement via trig, starting at 12 o'clock and
  // going clockwise — same "compute geometry from state, don't hand-author
  // coordinates" spirit as the other SVG-free renderers in this file.
  const n = values.length
  return values
    .map((v, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
      const x = cx + r * v * Math.cos(angle)
      const y = cy + r * v * Math.sin(angle)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function SpiderCompareCard({ decision, onResolve, resolving }) {
  // card_payload: { option_a: {key,label}, option_b: {key,label},
  //                 axes: [{key,label}, ...] }
  const payload = decision.card_payload && typeof decision.card_payload === 'object' ? decision.card_payload : {}
  const optionA = payload.option_a && typeof payload.option_a === 'object' ? payload.option_a : null
  const optionB = payload.option_b && typeof payload.option_b === 'object' ? payload.option_b : null
  const axes = safeArray(payload.axes).filter((a) => a && typeof a === 'object' && a.key !== undefined && a.key !== null)
  const [picks, setPicks] = React.useState({}) // axis_key -> 'a' | 'b' | 'tie'

  if (!optionA || !optionB || !optionA.key || !optionB.key || axes.length < 3) {
    // Need exactly 2 valid options and at least 3 axes for a sane polygon;
    // anything malformed (missing options, non-array axes, <3 axes) falls
    // back to the plain choice list rather than risking a crash or a
    // degenerate 1-2 vertex "shape".
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const labelA = safeText(optionA.label, safeText(optionA.key))
  const labelB = safeText(optionB.label, safeText(optionB.key))
  const allPicked = axes.every((ax) => picks[ax.key])
  const winsA = axes.filter((ax) => picks[ax.key] === 'a').length
  const winsB = axes.filter((ax) => picks[ax.key] === 'b').length
  const ties = axes.filter((ax) => picks[ax.key] === 'tie').length

  const pick = (axisKey, side) => {
    setPicks((prev) => ({ ...prev, [axisKey]: side }))
  }

  // Radial weight per axis: 1.0 toward the winner, 0.5 for a tie or an
  // as-yet-unpicked axis (keeps the polygon a legible regular shape before
  // all picks are in, rather than snapping to zero).
  const valuesA = axes.map((ax) => {
    const p = picks[ax.key]
    return p === 'a' ? 1 : p === 'b' ? 0 : 0.5
  })
  const valuesB = axes.map((ax) => {
    const p = picks[ax.key]
    return p === 'b' ? 1 : p === 'a' ? 0 : 0.5
  })

  const cx = 100
  const cy = 100
  const r = 78
  const n = axes.length
  const axisLines = axes.map((ax, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const x = cx + r * Math.cos(angle)
    const y = cy + r * Math.sin(angle)
    const lx = cx + (r + 14) * Math.cos(angle)
    const ly = cy + (r + 14) * Math.sin(angle)
    return { key: safeText(ax.key), x1: cx, y1: cy, x2: x, y2: y, lx, ly, label: safeText(ax.label, safeText(ax.key)) }
  })
  const outlinePoints = spiderPolygonPoints(axes.map(() => 1), cx, cy, r)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `For each criterion, pick which option wins — or call it a tie. The shape below is a read-only summary, it does not accept clicks.`,
      }),
      jsx('div', {
        className: 'flex justify-center',
        children: jsxs('svg', {
          viewBox: '0 0 200 200',
          width: 180,
          height: 180,
          role: 'img',
          'aria-label': 'Spider comparison chart (read-only summary)',
          children: [
            jsx('polygon', {
              points: outlinePoints,
              fill: 'none',
              stroke: 'var(--ui-stroke-secondary)',
              strokeWidth: 1,
            }),
            ...axisLines.map((al) =>
              jsx('line', {
                key: `spoke-${al.key}`,
                x1: al.x1,
                y1: al.y1,
                x2: al.x2,
                y2: al.y2,
                stroke: 'var(--ui-stroke-secondary)',
                strokeWidth: 1,
              })
            ),
            jsx('polygon', {
              points: spiderPolygonPoints(valuesA, cx, cy, r),
              fill: 'var(--ui-accent)',
              fillOpacity: 0.25,
              stroke: 'var(--ui-accent)',
              strokeWidth: 1.5,
            }),
            jsx('polygon', {
              points: spiderPolygonPoints(valuesB, cx, cy, r),
              fill: 'orange',
              fillOpacity: 0.2,
              stroke: 'orange',
              strokeWidth: 1.5,
            }),
          ],
        }),
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: axes.map((ax) => {
          const key = safeText(ax.key)
          const label = safeText(ax.label, key)
          const current = picks[key]
          return jsxs('div', {
            key,
            className: 'flex items-center justify-between gap-1 rounded-md px-2 py-1',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: [
              jsx('span', { className: 'text-[0.75rem] flex-1', children: label }),
              jsxs('div', {
                className: 'flex gap-1',
                children: [
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'a'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'a' ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                    children: labelA,
                  }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'tie'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'tie' ? 'var(--ui-text-secondary)' : 'var(--ui-stroke-secondary)'}` },
                    children: 'Tie',
                  }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'b'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'b' ? 'orange' : 'var(--ui-stroke-secondary)'}` },
                    children: labelB,
                  }),
                ],
              }),
            ],
          })
        }),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPicked
          ? `${labelA}: ${winsA}  ·  ${labelB}: ${winsB}  ·  Ties: ${ties}`
          : 'Pick a winner (or tie) for every criterion to see the tally.',
      }),
      jsx(ConfirmButton, {
        disabled: !allPicked,
        resolving,
        onClick: () => {
          const perAxisWinner = Object.fromEntries(axes.map((ax) => [safeText(ax.key), picks[safeText(ax.key)]]))
          const leader = winsA === winsB ? null : winsA > winsB ? labelA : labelB
          const summary = leader
            ? `${leader} wins ${Math.max(winsA, winsB)} of ${axes.length} axes${ties > 0 ? `, ${ties} tie${ties === 1 ? '' : 's'}` : ''}`
            : `${labelA} and ${labelB} tied overall (${winsA}-${winsB})${ties > 0 ? `, ${ties} tie${ties === 1 ? '' : 's'} on individual axes` : ''}`
          onResolve(decision.id, summary, {
            per_axis_winner: perAxisWinner,
            tally: { a: winsA, b: winsB, tie: ties },
            option_a: optionA.key,
            option_b: optionB.key,
            summary,
          })
        },
        children: 'Confirm comparison',
      }),
    ],
  })
}

function VennOverlapCard({ decision, onResolve, resolving }) {
  // card_payload: { set_a: { key, label }, set_b: { key, label }, allow_neither?: bool }
  // Shared-vs-exclusive-membership shape: click A-only / B-only / overlap
  // (and optionally a 4th "neither" zone outside both circles).
  //
  // Region-hit approach: two overlapping <circle>s are drawn as plain
  // visual fill (fully transparent to pointer events via
  // pointer-events:none on the base circles) and THREE separate,
  // purpose-built hit-area shapes are layered on top in z-order:
  //   1. an optional full-card background <rect> for "neither" (bottom)
  //   2. two "-only" hit shapes built with SVG <path> using evenodd
  //      fill-rule (circle minus the other circle's bounding path) so the
  //      overlap sliver is naturally excluded from the -only click areas
  //   3. one small overlap hit <ellipse> centered on the lens intersection
  //      (top), sized to sit inside the visual overlap lens
  // This avoids needing a true circle-circle path intersection formula —
  // the two "-only" paths use evenodd subtraction (self-intersecting path:
  // outer circle other winding order minus inner circle) which SVG computes
  // for us, and the overlap ellipse is a simple visual approximation that's
  // "close enough" to click accurately since it's centered in the lens and
  // sized comfortably smaller than the true lens area. Each of the 3 (or 4)
  // hit shapes has its own onClick — independently clickable, never a
  // shared handler with post-hoc geometry math.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : null
  const setA = p && p.set_a && typeof p.set_a === 'object' ? p.set_a : null
  const setB = p && p.set_b && typeof p.set_b === 'object' ? p.set_b : null
  if (!setA || !setB) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  const labelA = safeText(setA.label, safeText(setA.key, 'Set A'))
  const labelB = safeText(setB.label, safeText(setB.key, 'Set B'))
  const allowNeither = p.allow_neither === true

  const W = 260
  const H = 170
  const R = 60
  const cxA = W / 2 - 32
  const cxB = W / 2 + 32
  const cy = H / 2 - 6

  const resolveRegion = (region, label) => {
    onResolve(decision.id, `${label} (${region})`, { selected_region: region, summary: `${label} (${region})` })
  }

  return jsxs('div', {
    className: 'flex flex-col items-center gap-2',
    children: [
      jsxs('svg', {
        viewBox: `0 0 ${W} ${H}`,
        width: '100%',
        style: { maxWidth: 320, userSelect: 'none' },
        children: [
          // 4th "neither" zone: whole-card background rect, bottom of
          // z-order so it only catches clicks outside both circles.
          // Included as a clickable zone (not just implicit) whenever the
          // payload opts in via allow_neither, per the task's "use
          // judgment" call — most venn-style membership questions are
          // exhaustive (A/B/both), so it's opt-in rather than default-on.
          allowNeither
            ? jsx('rect', {
                x: 0,
                y: 0,
                width: W,
                height: H,
                fill: 'transparent',
                style: { cursor: 'pointer' },
                onClick: () => !resolving && resolveRegion('neither', 'Neither'),
              })
            : null,
          // Visual-only circles (no pointer events) purely for the fill/labels.
          jsx('circle', { cx: cxA, cy, r: R, fill: 'var(--ui-accent)', fillOpacity: 0.18, stroke: 'var(--ui-accent)', style: { pointerEvents: 'none' } }),
          jsx('circle', { cx: cxB, cy, r: R, fill: '#e5484d', fillOpacity: 0.18, stroke: '#e5484d', style: { pointerEvents: 'none' } }),
          // A-only hit area: circle A minus circle B, via evenodd subtraction path.
          jsx('path', {
            d: `M ${cxA - R} ${cy} A ${R} ${R} 0 1 0 ${cxA + R} ${cy} A ${R} ${R} 0 1 0 ${cxA - R} ${cy} Z ` +
               `M ${cxB - R} ${cy} A ${R} ${R} 0 1 0 ${cxB + R} ${cy} A ${R} ${R} 0 1 0 ${cxB - R} ${cy} Z`,
            fillRule: 'evenodd',
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('a_only', `${labelA} only`),
          }),
          // B-only hit area: circle B minus circle A, via evenodd subtraction path.
          jsx('path', {
            d: `M ${cxB - R} ${cy} A ${R} ${R} 0 1 0 ${cxB + R} ${cy} A ${R} ${R} 0 1 0 ${cxB - R} ${cy} Z ` +
               `M ${cxA - R} ${cy} A ${R} ${R} 0 1 0 ${cxA + R} ${cy} A ${R} ${R} 0 1 0 ${cxA - R} ${cy} Z`,
            fillRule: 'evenodd',
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('b_only', `${labelB} only`),
          }),
          // Overlap hit area: small ellipse centered in the lens, on top of
          // both "-only" paths so it wins the click there.
          jsx('ellipse', {
            cx: (cxA + cxB) / 2,
            cy,
            rx: (cxB - cxA) / 2,
            ry: R - 8,
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('overlap', `Both ${labelA} and ${labelB}`),
          }),
          jsx('text', { x: cxA - R + 8, y: cy - R - 6, className: 'text-[0.65rem]', fill: 'var(--ui-text-secondary)', children: labelA }),
          jsx('text', { x: cxB - 10, y: cy - R - 6, className: 'text-[0.65rem]', fill: 'var(--ui-text-secondary)', children: labelB }),
        ],
      }),
      jsx('div', {
        className: 'text-[0.65rem] text-(--ui-text-tertiary)',
        children: allowNeither
          ? `Click ${labelA}-only, ${labelB}-only, the overlap, or outside both for neither.`
          : `Click ${labelA}-only, ${labelB}-only, or the overlap.`,
      }),
    ],
  })
}

// size: 'default' (original, used by ModeRadialGaugeCard's larger card
// display) or 'compact' (roughly half the visual footprint, used by
// MetricDial inside the narrow MetricsSidebar). Only rendering constants
// (radius/stroke/viewBox/text size) change between sizes — the arc-angle
// math and the underlying value/fraction are identical either way.
function RadialGaugeDisplay({ value, min, max, unit, size = 'default' }) {
  const compact = size === 'compact'
  const cx = 100
  const cy = 100
  const r = compact ? 78 : 80
  const strokeWidth = compact ? 6 : 12
  const viewBoxHeight = compact ? 50 : 110
  const maxHeight = compact ? '65px' : '140px'
  const valueTextClass = compact ? 'text-[0.6rem] font-semibold' : 'text-[1.1rem] font-semibold'
  const valueTextY = compact ? cy - 4 : cy - 6
  const span = max - min
  const fraction = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0

  // Angle 180° (left, = min) sweeping down to 0° (right, = max).
  const pointAt = (frac) => {
    const theta = (180 - frac * 180) * (Math.PI / 180)
    return { x: cx + r * Math.cos(theta), y: cy - r * Math.sin(theta) }
  }
  const start = pointAt(0) // min, always the left end of the track
  const end = pointAt(1) // max, always the right end of the track
  const valuePoint = pointAt(fraction)

  // Background track: full 180° semicircle, min -> max.
  // large-arc-flag hardcoded to 0 (sweep is exactly 180°, per the gotcha).
  const trackPath = `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`
  // Value arc: min -> current value. Sweep is <=180° by construction
  // (fraction is clamped to [0,1] over a fixed 180° span), so
  // large-arc-flag is hardcoded to 0 here too — NEVER computed from
  // fraction/percentage, per the documented pitfall.
  const valuePath = `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${valuePoint.x} ${valuePoint.y}`

  return jsxs('svg', {
    viewBox: `0 0 200 ${viewBoxHeight}`,
    className: 'w-full',
    style: { maxHeight },
    children: [
      jsx('path', {
        d: trackPath,
        fill: 'none',
        stroke: 'var(--ui-stroke-secondary)',
        strokeWidth,
        strokeLinecap: 'round',
      }),
      jsx('path', {
        d: valuePath,
        fill: 'none',
        stroke: 'var(--ui-accent)',
        strokeWidth,
        strokeLinecap: 'round',
      }),
      jsx('text', {
        x: cx,
        y: valueTextY,
        textAnchor: 'middle',
        className: valueTextClass,
        fill: 'var(--ui-accent)',
        children: `${safeText(value)}${safeText(unit, '')}`,
      }),
    ],
  })
}

function ModeRadialGaugeCard({ decision, onResolve, resolving }) {
  // card_payload: { modes: [{ key, label, gauge_value, gauge_min, gauge_max, unit? }] }
  const rawModes = safeArray(decision.card_payload && decision.card_payload.modes)
  // Every mode must carry a key/label plus the three numeric gauge fields —
  // a mode missing any of these can't drive the view-only gauge safely, so
  // it's filtered out here rather than crashing mid-render.
  const modes = rawModes.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      m.key !== undefined &&
      m.key !== null &&
      typeof m.gauge_value === 'number' &&
      isFinite(m.gauge_value) &&
      typeof m.gauge_min === 'number' &&
      isFinite(m.gauge_min) &&
      typeof m.gauge_max === 'number' &&
      isFinite(m.gauge_max)
  )

  const [selectedKey, setSelectedKey] = React.useState(() => (modes[0] ? safeText(modes[0].key) : null))

  if (modes.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const selected = modes.find((m) => safeText(m.key) === selectedKey) || modes[0]

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'flex flex-wrap justify-center gap-1.5',
        children: modes.map((m) => {
          const key = safeText(m.key)
          const isActive = key === safeText(selected.key)
          return jsx('button', {
            key,
            type: 'button',
            role: 'radio',
            'aria-checked': isActive,
            disabled: resolving,
            onClick: () => setSelectedKey(key),
            className: cn(
              'rounded-md px-2.5 py-1.5 text-[0.8rem] font-medium transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: {
              border: `1px solid ${isActive ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
              color: isActive ? 'var(--ui-accent)' : undefined,
            },
            children: safeText(m.label, key),
          })
        }),
      }),
      // Gauge is a pure display driven by `selected` — it has no onClick,
      // no drag handlers, and no pointer state of its own.
      jsx(RadialGaugeDisplay, {
        value: selected.gauge_value,
        min: selected.gauge_min,
        max: selected.gauge_max,
        unit: selected.unit,
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const key = safeText(selected.key)
          const label = safeText(selected.label, key)
          const unit = safeText(selected.unit, '')
          onResolve(decision.id, `${label}: ${selected.gauge_value}${unit}`, {
            selected_mode_key: selected.key,
            gauge_value_at_confirm: selected.gauge_value,
          })
        },
        children: `Confirm ${safeText(selected.label, safeText(selected.key))}`,
      }),
    ],
  })
}

function ContextReadoutCard({ decision, onResolve, resolving }) {
  const payload = decision.card_payload
  const variant = payload && payload.variant

  let body = null
  if (variant === 'stat_delta') {
    const value = payload.value
    const delta = payload.delta
    const validValue = typeof value === 'string' || typeof value === 'number'
    if (validValue && isFiniteNumber(delta)) {
      body = jsx(StatDeltaBody, { payload: { label: payload.label, value, delta, unit: payload.unit } })
    }
  } else if (variant === 'sparkline') {
    const points = safeArray(payload.points).filter(isFiniteNumber)
    if (points.length >= 2 && points.length === safeArray(payload.points).length) {
      body = jsx(SparklineBody, { payload: { label: payload.label, points, unit: payload.unit } })
    }
  } else if (variant === 'compare_bars') {
    const rawBars = safeArray(payload && payload.bars)
    const bars = rawBars.filter((b) => b && (typeof b.label === 'string' || typeof b.label === 'number') && isFiniteNumber(b.value))
    if (bars.length > 0 && bars.length === rawBars.length) {
      body = jsx(CompareBarsBody, { payload: { label: payload.label, bars, unit: payload.unit } })
    }
  }

  if (!body) {
    // Malformed/unrecognized variant, or variant-specific fields failed
    // their guard — never crash, fall back to the plain choice list. NOTE:
    // this is an odd fallback for a card that by definition has no
    // decision to make (DefaultChoiceCard will show real clickable
    // "choices" for a context-only row) but it's still strictly better
    // than a blank pane or a thrown error, and matches every other
    // renderer's malformed-payload contract in this file.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      body,
      jsx(DismissButton, {
        resolving,
        onClick: () => onResolve(decision.id, 'Acknowledged', { acknowledged: true, variant }),
      }),
    ],
  })
}

function TimelinePlacementCard({ decision, onResolve, resolving }) {
  // card_payload: { ticks: [{ key, label }], default_tick_key }
  // Discrete dated track, NOT a continuous scalar (see ScalarSliderCard):
  // the marker only ever lands on one of `ticks`, never an in-between
  // pixel/value. Interaction choice: a native `input[type=range]` whose
  // value is the tick INDEX (min 0, max ticks.length-1, step 1) rather than
  // hand-rolled mousedown/mousemove/mouseup hit-testing — the browser's own
  // range-input drag/keyboard/touch handling already snaps to integer steps
  // for free, so there is no continuous position to round and no custom
  // pointer math that could produce an off-track index. A separate visual
  // track below renders the marker and tick labels at discrete x-positions
  // derived purely from the index (i / (len-1) * 100%), matching the range
  // input's value — the range input IS the drag surface, the track below is
  // the read-only visual representation of the same discrete state.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const ticks = safeArray(p.ticks).filter(
    (t) => t && typeof t === 'object' && t.key !== undefined && t.key !== null && t.label !== undefined
  )

  if (ticks.length < 2) {
    // Missing/malformed ticks, or fewer than 2 (nothing meaningful to place
    // onto a track) — never crash, fall back to the plain choice list.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const defaultIdx = (() => {
    const idx = ticks.findIndex((t) => safeText(t.key) === safeText(p.default_tick_key))
    return idx >= 0 ? idx : 0
  })()
  const [index, setIndex] = React.useState(defaultIdx)
  // Guard against NaN/non-finite index (e.g. a malformed onChange value)
  // before clamping — Math.min/max propagate NaN silently otherwise, which
  // would index the ticks array out of bounds and crash the render below.
  const safeIndex = Number.isFinite(index) ? index : defaultIdx
  const clampedIndex = Math.round(Math.min(Math.max(safeIndex, 0), ticks.length - 1))
  const selected = ticks[clampedIndex]
  const pct = (i) => (ticks.length === 1 ? 0 : (i / (ticks.length - 1)) * 100)

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'text-center text-sm font-semibold',
        style: { color: 'var(--ui-accent)' },
        children: safeText(selected.label, safeText(selected.key)),
      }),
      jsxs('div', {
        className: 'relative pt-3 pb-5',
        children: [
          // Track line
          jsx('div', {
            className: 'absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2',
            style: { background: 'var(--ui-stroke-secondary)' },
          }),
          // Tick marks + labels, positioned at discrete percentages only
          ...ticks.map((t, i) =>
            jsxs('div', {
              key: safeText(t.key, `tick-${i}`),
              className: 'absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1',
              style: { left: `${pct(i)}%` },
              children: [
                jsx('div', {
                  className: 'h-2 w-0.5',
                  style: { background: 'var(--ui-stroke-secondary)' },
                }),
                jsx('div', {
                  className: 'w-max max-w-[4.5rem] text-center text-[0.6rem] leading-tight text-(--ui-text-tertiary)',
                  children: safeText(t.label, safeText(t.key)),
                }),
              ],
            })
          ),
          // Draggable marker — visual position only ever reads the discrete
          // `clampedIndex`, never a raw pixel/event coordinate.
          jsx('div', {
            className: 'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full',
            style: { left: `${pct(clampedIndex)}%`, background: 'var(--ui-accent)' },
          }),
        ],
      }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: ticks.length - 1,
        step: 1,
        value: clampedIndex,
        disabled: resolving,
        onChange: (e) => setIndex(Number(e.target.value)),
        className: 'w-full',
        'aria-label': 'Timeline placement',
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const key = selected.key
          const label = safeText(selected.label, safeText(key))
          onResolve(decision.id, label, { selected_tick_key: key })
        },
        children: `Confirm ${safeText(selected.label, safeText(selected.key))}`,
      }),
    ],
  })
}

function TreePlacementCard({ decision, onResolve, resolving }) {
  const payload = safePlainObject(decision.card_payload) || {}
  const tree = safePlainObject(payload.tree)
  const items = safeArray(payload.items).filter((it) => it && typeof it === 'object' && it.key !== undefined && it.key !== null)

  const leafLabels = React.useMemo(() => {
    const out = {}
    if (tree) collectTreeLeaves(tree, 0, out)
    return out
  }, [tree])

  const [placements, setPlacements] = React.useState({}) // item_key -> leaf key
  const [activeItemKey, setActiveItemKey] = React.useState(null)
  const [expandedKeys, setExpandedKeys] = React.useState(
    () => new Set(tree && tree.key !== undefined && tree.key !== null ? [safeText(tree.key)] : [])
  )

  // Bail to the plain fallback for any malformed/missing shape: no tree
  // object, no key on the root, no reachable leaf categories, or an
  // empty/missing items array. This is checked AFTER the hooks above so
  // hook order stays stable across renders regardless of payload shape.
  const treeValid = !!tree && tree.key !== undefined && tree.key !== null && Object.keys(leafLabels).length > 0
  if (!treeValid || items.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const toggleExpand = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const onPlaceActive = (leafKey) => {
    if (!activeItemKey) return
    setPlacements((prev) => ({ ...prev, [activeItemKey]: leafKey }))
    // advance to the next unplaced item, if any, for a faster placement flow
    const remaining = items.map((it) => safeText(it.key)).filter((k) => k !== activeItemKey && !placements[k])
    setActiveItemKey(remaining.length > 0 ? remaining[0] : null)
  }

  const allPlaced = items.every((it) => !!placements[safeText(it.key)])

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click an item, then click a leaf category to place it.',
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1.5',
        children: items.map((it) => {
          const key = safeText(it.key)
          const label = safeText(it.label, key)
          const placedLeaf = placements[key]
          return jsxs('button', {
            type: 'button',
            key,
            disabled: resolving,
            onClick: () => setActiveItemKey(key === activeItemKey ? null : key),
            className: 'flex items-center gap-1 rounded-full px-2 py-1 text-[0.72rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: {
              border: `1px solid ${key === activeItemKey ? 'var(--ui-accent)' : placedLeaf ? 'var(--ui-text-tertiary)' : 'var(--ui-stroke-secondary)'}`,
            },
            children: [
              label,
              placedLeaf ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: `→ ${safeText(leafLabels[placedLeaf], placedLeaf)}` }) : null,
            ],
          })
        }),
      }),
      jsx('div', {
        className: 'flex flex-col gap-1 rounded-md p-1.5',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: jsx(TreeNode, {
          node: tree,
          depth: 0,
          expandedKeys,
          toggleExpand,
          placements,
          leafLabels,
          activeItem: activeItemKey,
          onPlaceActive,
        }),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPlaced
          ? 'All items placed.'
          : `${items.filter((it) => !!placements[safeText(it.key)]).length}/${items.length} placed.`,
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it) => {
              const key = safeText(it.key)
              const leafKey = placements[key]
              return `${safeText(it.label, key)} → ${safeText(leafLabels[leafKey], leafKey)}`
            })
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

const CARD_RENDERERS = {
  quad_choice: QuadChoiceCard,
  multi_select: MultiSelectCard,
  sequence_order: SequenceOrderCard,
  assemble_pieces: AssemblePiecesCard,
  balance_scale: BalanceScaleCard,
  weighted_allocation: WeightedAllocationCard,
  scalar_slider: ScalarSliderCard,
  zone_select: ZoneSelectCard,
  range_slider: RangeSliderCard,
  anchor_adjust: AnchorAdjustCard,
  wire_match: WireMatchCard,
  sort_to_bin: SortToBinCard,
  matrix_2x2: Matrix2x2Card,
  stacked_bar_split: StackedBarSplitCard,
  pairwise_duel: PairwiseDuelCard,
  spider_compare: SpiderCompareCard,
  venn_overlap: VennOverlapCard,
  mode_radial_gauge: ModeRadialGaugeCard,
  context_readout: ContextReadoutCard,
  timeline_placement: TimelinePlacementCard,
  tree_placement: TreePlacementCard,
  confidence_rating: ConfidenceRatingCard,
  constrained_budget_split: ConstrainedBudgetSplitCard,
}

// CardErrorBoundary: isolates a single card's render exception so a
// malformed/adversarial decision row (bad DB row, bad MCP push, future
// card_type bug) cannot take down the whole Decision HUD pane — every other
// card in the queue, including a batch_approval gate card, keeps rendering
// and stays actionable. Deliberately renders NO action buttons in the
// fallback (not even the plain choice list) so a decision whose payload
// blew up mid-render can never surface an "approve" (or any other) click
// target — the malformed row is surfaced read-only until fixed at the
// source.
class CardErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[decision-hud] card render error', this.props.decisionId, error, info)
  }

  render() {
    if (this.state.hasError) {
      return jsxs('div', {
        className: 'flex flex-col gap-1 rounded-md px-2.5 py-2 text-[0.75rem]',
        style: { border: '1px dashed var(--ui-danger, #e5484d)', color: 'var(--ui-danger, #e5484d)' },
        children: [
          jsx('div', { className: 'font-medium', children: '⚠ Malformed decision data' }),
          jsx('div', {
            className: 'text-(--ui-text-tertiary)',
            children: 'This card could not be rendered safely and has been isolated. No action was taken. Check the underlying decision row.',
          }),
        ],
      })
    }
    return this.props.children
  }
}

function DecisionCard({ decision, onResolve, onDefer, resolving }) {
  const Body = CARD_RENDERERS[decision.card_type] || DefaultChoiceCard
  const isContextReadout = decision.card_type === 'context_readout'
  return jsxs('div', {
    className: cn(
      'flex flex-col gap-3 rounded-lg border p-4',
      isContextReadout ? '' : 'border-(--ui-stroke-secondary)'
    ),
    // Dashed border for Context Readout distinguishes it at a glance from
    // every solid-bordered real decision card in the stack.
    style: isContextReadout ? { border: '1px dashed var(--ui-stroke-secondary)' } : undefined,
    children: [
      jsx(CardHeader, { decision }),
      isContextReadout ? jsx(ContextReadoutTag, {}) : null,
      jsx(CardQuestion, { decision }),
      jsx(CardErrorBoundary, { decisionId: decision && decision.id, children: jsx(Body, { decision, onResolve, resolving }) }),
      // Shared across every card type (present vs future) — deliberately
      // outside Body so a new CARD_RENDERERS entry gets Defer for free
      // without having to remember to wire it per-renderer.
      jsx(DeferButton, { disabled: resolving, onClick: () => onDefer(decision.id) }),
    ],
  })
}

function useBoardSettings(boardSlug) {
  // Fetches dispatch_enabled/auto_decompose_enabled/review_dispatch_enabled for
  // one board via `hermes kanban boards show <slug> --json`. Only fetches when
  // boardSlug is a real slug (never for "All" — that's selectedBoard === null).
  const [state, setState] = React.useState({ settings: null, loading: false, error: null })

  const refresh = React.useCallback(async () => {
    if (!boardSlug) {
      setState({ settings: null, loading: false, error: null })
      return
    }
    setState((s) => ({ ...s, loading: true }))
    try {
      const res = await cliExec(['kanban', 'boards', 'show', boardSlug, '--json'])
      setState({
        settings: {
          dispatch_enabled: res.dispatch_enabled !== false,
          auto_decompose_enabled: res.auto_decompose_enabled !== false,
          review_dispatch_enabled: res.review_dispatch_enabled !== false,
        },
        loading: false,
        error: null,
      })
    } catch (e) {
      setState({ settings: null, loading: false, error: String(e.message || e) })
    }
  }, [boardSlug])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  return { ...state, refresh }
}

const BOARD_SETTINGS_FIELDS = [
  { key: 'dispatch_enabled', verb: 'set-dispatch', label: 'Dispatch' },
  { key: 'auto_decompose_enabled', verb: 'set-auto-decompose', label: 'Auto-decompose' },
  { key: 'review_dispatch_enabled', verb: 'set-review-dispatch', label: 'Review-dispatch' },
]

function ToggleSwitch({ checked, disabled, onClick }) {
  return jsx('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled,
    onClick,
    className: cn(
      'relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-40'
    ),
    style: { background: checked ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)' },
    children: jsx('span', {
      className: 'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
      style: { left: checked ? '14px' : '2px' },
    }),
  })
}

function BoardSettingsPanel({ boardSlug }) {
  // Per-board settings: dispatch_enabled / auto_decompose_enabled /
  // review_dispatch_enabled, added in commit 57803b97f3 (hermes kanban
  // boards set-dispatch / set-auto-decompose / set-review-dispatch).
  // Renders nothing for "All" (boardSlug === null) — this is a per-board
  // panel, not a global settings view.
  const { settings, loading, error, refresh } = useBoardSettings(boardSlug)
  const [pending, setPending] = React.useState(null) // field key currently in flight
  const [optimistic, setOptimistic] = React.useState(null) // local override while a toggle is in flight

  React.useEffect(() => {
    setOptimistic(null)
  }, [boardSlug])

  if (!boardSlug) return null

  const effective = optimistic || settings

  const handleToggle = async (field) => {
    if (!effective || pending) return
    const nextVal = !effective[field.key]
    haptic('tap')
    setPending(field.key)
    setOptimistic({ ...effective, [field.key]: nextVal })
    try {
      await cliExec(['kanban', 'boards', field.verb, boardSlug, nextVal ? 'on' : 'off'])
      host.notify({ kind: 'success', message: `${field.label} ${nextVal ? 'enabled' : 'disabled'} for ${boardSlug}` })
      await refresh()
      setOptimistic(null)
    } catch (e) {
      // rollback
      setOptimistic(null)
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setPending(null)
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1.5 rounded-lg border p-2.5 text-[0.75rem]',
    style: { border: '1px solid var(--ui-stroke-secondary)' },
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between',
        children: [
          jsx('div', {
            className: 'font-medium text-(--ui-text-secondary)',
            children: `Board settings — ${boardSlug}`,
          }),
          loading ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: '…' }) : null,
        ],
      }),
      error
        ? jsx('div', { className: 'text-(--ui-danger,#e5484d)', children: error })
        : null,
      effective
        ? jsx('div', {
            className: 'flex flex-col gap-1.5',
            children: BOARD_SETTINGS_FIELDS.map((field) =>
              jsxs('div', {
                key: field.key,
                className: 'flex items-center justify-between gap-2',
                children: [
                  jsx('span', { className: 'text-(--ui-text-secondary)', children: field.label }),
                  jsx(ToggleSwitch, {
                    checked: !!effective[field.key],
                    disabled: pending !== null,
                    onClick: () => handleToggle(field),
                  }),
                ],
              })
            ),
          })
        : null,
    ],
  })
}

function BoardSelector({ boards, active, onSelect }) {
  // TODO: wire to decision filtering once board↔project mapping is decided.
  // Kanban boards (`hermes kanban boards list --json`) and decision-hud
  // "projects" (`hermes decision projects`) are two independent taxonomies
  // today — most boards carry `project_id: null` (only the 'default' board
  // has one set), so there is no reliable board -> project join to filter
  // the decision queue by yet. Until that mapping exists, this selector is
  // UI state only (`selectedBoard` in DecisionHudPane) and does not affect
  // which decisions/projects are fetched or displayed below it.
  return jsxs('div', {
    className: 'flex flex-wrap gap-1 border-b border-(--ui-stroke-secondary) pb-2',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => onSelect(null),
        className: cn(
          'rounded px-2 py-0.5 text-[0.7rem]',
          active === null ? 'bg-(--chrome-action-hover)' : 'text-(--ui-text-tertiary)'
        ),
        children: 'All',
      }),
      ...boards.map((b) =>
        jsx(
          'button',
          {
            key: b.slug,
            type: 'button',
            onClick: () => onSelect(b.slug),
            className: cn(
              'rounded px-2 py-0.5 text-[0.7rem]',
              active === b.slug ? 'bg-(--chrome-action-hover)' : 'text-(--ui-text-tertiary)'
            ),
            children: b.name || b.slug,
          }
        )
      ),
    ],
  })
}

function ProjectSwitcher({ projects, active, onSelect }) {
  return jsxs('div', {
    className: 'flex flex-wrap gap-1 border-b border-(--ui-stroke-secondary) pb-2',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => onSelect(null),
        className: cn(
          'rounded px-2 py-0.5 text-[0.7rem]',
          active === null ? 'bg-(--chrome-action-hover)' : 'text-(--ui-text-tertiary)'
        ),
        children: 'all',
      }),
      ...projects.map((p) =>
        jsx(
          'button',
          {
            key: p.project_id,
            type: 'button',
            onClick: () => onSelect(p.project_id),
            className: cn(
              'rounded px-2 py-0.5 text-[0.7rem]',
              active === p.project_id ? 'bg-(--chrome-action-hover)' : 'text-(--ui-text-tertiary)'
            ),
            children: `${p.slug || p.project_id} (${p.pending})`,
          }
        )
      ),
    ],
  })
}

const GRID_LAYOUT_STORAGE_KEY = 'decision-hud:grid-layout'
const GRID_MIN = 1
const GRID_MAX = 3

const SIDEBAR_SETTINGS_STORAGE_KEY = 'decision-hud:sidebar-settings'
const SIDEBAR_WIDTH_MIN = 140
const SIDEBAR_WIDTH_MAX = 320
const SIDEBAR_WIDTH_DEFAULT = 200
const DIAL_COLS_MIN = 1
const DIAL_COLS_MAX = 2

// loadSidebarSettings/saveSidebarSettings: side (left/right), widthPx (the
// sidebar's max-width cap in px, replacing the old hardcoded 200), and
// dialCols (metric-dial grid column count) all live in one small settings
// object, same persistence pattern as loadGridLayout/saveGridLayout above.
function loadSidebarSettings() {
  try {
    const raw = localStorage.getItem(SIDEBAR_SETTINGS_STORAGE_KEY)
    if (!raw) return { side: 'left', widthPx: SIDEBAR_WIDTH_DEFAULT, dialCols: 1 }
    const parsed = JSON.parse(raw)
    const side = parsed.side === 'right' ? 'right' : 'left'
    const widthPx = Number.isFinite(parsed.widthPx)
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, parsed.widthPx))
      : SIDEBAR_WIDTH_DEFAULT
    const dialCols = Number.isInteger(parsed.dialCols)
      ? Math.min(DIAL_COLS_MAX, Math.max(DIAL_COLS_MIN, parsed.dialCols))
      : 1
    return { side, widthPx, dialCols }
  } catch {
    return { side: 'left', widthPx: SIDEBAR_WIDTH_DEFAULT, dialCols: 1 }
  }
}

function saveSidebarSettings(settings) {
  try {
    localStorage.setItem(SIDEBAR_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // best-effort — a failed localStorage write just means these settings
    // reset to default next session, never a crash (same as saveGridLayout).
  }
}

function loadGridLayout() {
  try {
    const raw = localStorage.getItem(GRID_LAYOUT_STORAGE_KEY)
    if (!raw) return { cols: 1, rows: 3 }
    const parsed = JSON.parse(raw)
    const cols = Number.isInteger(parsed.cols) ? Math.min(GRID_MAX, Math.max(GRID_MIN, parsed.cols)) : 1
    const rows = Number.isInteger(parsed.rows) ? Math.min(GRID_MAX, Math.max(GRID_MIN, parsed.rows)) : 3
    return { cols, rows }
  } catch {
    return { cols: 1, rows: 3 }
  }
}

function saveGridLayout(layout) {
  try {
    localStorage.setItem(GRID_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // best-effort — a failed localStorage write (private mode, quota) just
    // means the layout resets to default next session, never a crash.
  }
}

// GridLayoutControls: a static (not resizable-by-drag) NxM picker, 1-3 cols
// x 1-3 rows, persisted across sessions. "Static" per the owner's request —
// this sets a fixed grid shape, it does not add drag-to-resize panes.
function GridLayoutControls({ layout, onChange }) {
  const stepper = (label, key, value) =>
    jsxs('div', {
      className: 'flex items-center gap-1',
      children: [
        jsx('span', { className: 'text-[0.65rem] text-(--ui-text-tertiary)', children: label }),
        jsx('button', {
          type: 'button',
          disabled: value <= GRID_MIN,
          onClick: () => onChange({ ...layout, [key]: Math.max(GRID_MIN, value - 1) }),
          className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
          children: '−',
        }),
        jsx('span', { className: 'w-3 text-center text-[0.7rem] tabular-nums', children: value }),
        jsx('button', {
          type: 'button',
          disabled: value >= GRID_MAX,
          onClick: () => onChange({ ...layout, [key]: Math.min(GRID_MAX, value + 1) }),
          className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
          children: '+',
        }),
      ],
    })
  return jsxs('div', {
    className: 'flex items-center gap-3 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Grid' }),
      stepper('cols', 'cols', layout.cols),
      stepper('rows', 'rows', layout.rows),
    ],
  })
}


// SidebarPositionControls: left/right toggle + width stepper for the
// metrics sidebar, persisted via loadSidebarSettings/saveSidebarSettings.
function SidebarPositionControls({ settings, onChange }) {
  return jsxs('div', {
    className: 'flex items-center gap-3 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Sidebar' }),
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('button', {
            type: 'button',
            'aria-label': 'Sidebar left',
            onClick: () => onChange({ ...settings, side: 'left' }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.side === 'left' ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: 'Left',
          }),
          jsx('button', {
            type: 'button',
            'aria-label': 'Sidebar right',
            onClick: () => onChange({ ...settings, side: 'right' }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.side === 'right' ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: 'Right',
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('button', {
            type: 'button',
            disabled: settings.widthPx <= SIDEBAR_WIDTH_MIN,
            onClick: () => onChange({ ...settings, widthPx: Math.max(SIDEBAR_WIDTH_MIN, settings.widthPx - 20) }),
            className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
            children: '−',
          }),
          jsx('span', { className: 'w-9 text-center text-[0.65rem] tabular-nums', children: `${settings.widthPx}px` }),
          jsx('button', {
            type: 'button',
            disabled: settings.widthPx >= SIDEBAR_WIDTH_MAX,
            onClick: () => onChange({ ...settings, widthPx: Math.min(SIDEBAR_WIDTH_MAX, settings.widthPx + 20) }),
            className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
            children: '+',
          }),
        ],
      }),
    ],
  })
}

// DialGridControls: grid-select (1 or 2 columns) for the metric dials'
// layout inside MetricsSidebar — distinct from GridLayoutControls, which
// controls the decision-card grid in the main column, not the dials.
function DialGridControls({ settings, onChange }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Dials' }),
      jsx('div', {
        className: 'flex items-center gap-1',
        children: [DIAL_COLS_MIN, DIAL_COLS_MAX].map((n) =>
          jsx('button', {
            key: n,
            type: 'button',
            'aria-label': `${n} column${n > 1 ? 's' : ''}`,
            onClick: () => onChange({ ...settings, dialCols: n }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.dialCols === n ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: `${n}col`,
          })
        ),
      }),
    ],
  })
}


// SettingsPopover: small anchored dropdown/panel opened from the gear icon
// in the DecisionHudPane header. Deliberately generic ("settings panel with
// sections") so future settings can be added as additional labeled section
// divs — grid size, sidebar position/width, and dial grid are the sections
// today.
function SettingsPopover({ layout, onGridChange, sidebarSettings, onSidebarChange }) {
  return jsx('div', {
    className:
      'absolute right-0 top-full z-10 mt-1 w-max rounded-md border border-(--ui-stroke-secondary) bg-(--ui-surface-primary) p-2 shadow-lg',
    children: jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx('div', {
          className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
          children: 'Grid size',
        }),
        jsx(GridLayoutControls, { layout, onChange: onGridChange }),
        jsx(SidebarPositionControls, { settings: sidebarSettings, onChange: onSidebarChange }),
        jsx(DialGridControls, { settings: sidebarSettings, onChange: onSidebarChange }),
      ],
    }),
  })
}


// --- Left-hand metrics/dials sidebar -------------------------------------
//
// Real numbers only, computed from data this pane already polls (decisions,
// boards) plus one extra lightweight CLI call for the necessity rate —
// never fabricated placeholders. A metric with no real signal yet (e.g. no
// resolved rows) renders as an explicit "n/a", matching the same
// honest-gap convention as decision-hub-integration/metrics_dashboard.py.
function useHudMetrics(decisions, boards) {
  const [necessity, setNecessity] = React.useState({ loading: true, rate: null, marked: 0, error: null })

  React.useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await cliExec(['decision', 'necessity-rate'])
        if (cancelled) return
        setNecessity({
          loading: false,
          rate: typeof res.escalation_necessity_rate === 'number' ? res.escalation_necessity_rate : null,
          marked: res.marked_count || 0,
          error: null,
        })
      } catch (e) {
        if (cancelled) return
        setNecessity((s) => ({ ...s, loading: false, error: String(e.message || e) }))
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return React.useMemo(() => {
    const pendingCount = decisions.length
    const highUrgencyCount = decisions.filter((d) => d.urgency === 'high').length
    const cardCount = decisions.filter((d) => d.card_type).length
    const cardCoverage = pendingCount > 0 ? cardCount / pendingCount : null
    // "Gated" = review_dispatch_enabled: the kanban-side knob closest to a
    // batch-approval-style gate today (dispatch requires a review pass
    // before landing). This is still a proxy metric, not a direct count of
    // boards with an actual OPEN/pending batch_approval row for their linked
    // project — the board<->project_id join now exists (DecisionHudPane's
    // selectedBoardProjectId) and COULD support that tighter count, but
    // nothing has wired it through to this metric yet.
    const boardsGated = boards.filter((b) => b && b.review_dispatch_enabled).length
    return {
      pendingCount,
      highUrgencyCount,
      cardCoverage,
      boardsTotal: boards.length,
      boardsGated,
      necessity,
    }
  }, [decisions, boards, necessity])
}

// useAgentHealth: sorted agent-health roster for the metrics sidebar.
//
// Real numbers only, same convention as useHudMetrics above: this pulls the
// known-agent roster from `hermes kanban assignees --json` (confirmed shape:
// a bare array of `{ name, on_disk, counts }`, where `counts` is commonly
// `{}` in an environment with no active task data — never assume it has any
// particular status keys) plus `hermes kanban stats --json` (confirmed
// shape: `{ by_status, by_assignee, oldest_ready_age_seconds, now }`, also
// commonly empty). Per-agent blocked/running task counts would ideally come
// from `by_assignee`, but when that's empty (as observed) there is no real
// per-agent signal available today — this renders those agents as
// "no data" rather than inventing a fabricated score. This is a deliberately
// simple MVP: sort by blocked-task count descending (most stuck first), then
// running-task count descending, as tie-break. See
// decision-hub-integration/research-composite-health-score-agent4.md for the
// future EWMA composite design — not implemented here.
function useAgentHealth() {
  const [state, setState] = React.useState({ agents: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      const [assigneesRes, statsRes] = await Promise.all([
        cliExec(['kanban', 'assignees', '--json']),
        cliExec(['kanban', 'stats', '--json']),
      ])
      const roster = Array.isArray(assigneesRes) ? assigneesRes : []
      const byAssignee = (statsRes && typeof statsRes === 'object' && statsRes.by_assignee) || {}

      const agents = roster.map((a) => {
        const name = (a && a.name) || 'unknown'
        // Prefer real per-agent breakdowns from kanban stats' by_assignee
        // when present; fall back to the roster's own `counts` field
        // (also real CLI data, just from a different endpoint). Neither is
        // guaranteed to carry any status keys in a quiet environment.
        const fromStats = byAssignee[name] || null
        const fromRoster = (a && a.counts) || {}
        const counts = fromStats && typeof fromStats === 'object' ? fromStats : fromRoster
        const blocked = typeof counts.blocked === 'number' ? counts.blocked : 0
        const running = typeof counts.running === 'number' ? counts.running : 0
        const hasData = Object.keys(counts).length > 0
        return {
          name,
          onDisk: Boolean(a && a.on_disk),
          blocked,
          running,
          hasData,
        }
      })

      // Unhealthiest first: most blocked work first, running count as
      // tie-break. Agents with no real signal float to the bottom, shown as
      // neutral "no data" rather than sorted as if they were healthy.
      agents.sort((x, y) => {
        if (x.hasData !== y.hasData) return x.hasData ? -1 : 1
        if (y.blocked !== x.blocked) return y.blocked - x.blocked
        return y.running - x.running
      })

      setState({ agents, loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

// AgentHealthList: compact rows below the dials, one per known agent,
// sorted unhealthiest-first (see useAgentHealth). Honest empty/neutral
// states instead of a fabricated ranking, matching the "n/a" / "no pending
// rows" convention used elsewhere in this sidebar.
function AgentHealthList({ health }) {
  const { agents, loading, error } = health

  if (error) {
    return jsx('div', {
      className: 'text-[0.65rem] text-(--ui-danger,#e5484d)',
      children: 'agent health: error',
    })
  }
  if (loading) {
    return jsx('div', {
      className: 'text-center text-[0.65rem] text-(--ui-text-tertiary)',
      children: 'agent health: loading…',
    })
  }
  if (agents.length === 0) {
    return jsx('div', {
      className: 'text-center text-[0.65rem] text-(--ui-text-tertiary)',
      children: 'agent health: no agents',
    })
  }

  const anyData = agents.some((a) => a.hasData)

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', {
        className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Agent health',
      }),
      !anyData
        ? jsx('div', {
            className: 'text-center text-[0.6rem] text-(--ui-text-tertiary)',
            children: 'n/a (no per-agent task data yet)',
          })
        : jsx('div', {
            className: 'flex flex-col gap-0.5',
            children: agents.map((a) =>
              jsxs('div', {
                key: a.name,
                className: 'flex items-center justify-between gap-1 text-[0.65rem]',
                children: [
                  jsx('span', {
                    className: 'truncate text-(--ui-text-secondary)',
                    children: a.name,
                  }),
                  jsx('span', {
                    className: a.hasData ? 'text-(--ui-text-tertiary)' : 'text-(--ui-text-tertiary) opacity-50',
                    children: a.hasData ? `${a.blocked}b / ${a.running}r` : 'no data',
                  }),
                ],
              })
            ),
          }),
    ],
  })
}

function MetricDial({ label, value, min, max, unit, subtitle }) {
  return jsxs('div', {
    className: 'flex flex-col items-center gap-1 rounded-lg border border-(--ui-stroke-secondary) p-2',
    children: [
      jsx('div', {
        className: 'w-full',
        children: jsx(RadialGaugeDisplay, { value, min, max, unit, size: 'compact' }),
      }),
      jsx('div', { className: 'text-center text-[0.7rem] font-medium', children: label }),
      subtitle
        ? jsx('div', { className: 'text-center text-[0.6rem] text-(--ui-text-tertiary)', children: subtitle })
        : null,
    ],
  })
}

// MetricsSidebar: dials/metrics panel, matching the plugin header comment's
// original "switchable visualization" placeholder — this is the real
// implementation of that slot, not a further placeholder. Side (left/right)
// and width are now user-configurable settings instead of a hardcoded
// left-only w-1/4/max-w-[200px] class.
function MetricsSidebar({ metrics, agentHealth, side, widthPx, dialCols }) {
  const { pendingCount, highUrgencyCount, cardCoverage, boardsTotal, boardsGated, necessity } = metrics
  const borderClass = side === 'right' ? 'border-l pl-3' : 'border-r pr-3'
  return jsxs('div', {
    className: `flex shrink-0 flex-col gap-3 overflow-y-auto border-(--ui-stroke-secondary) ${borderClass}`,
    style: { width: `${widthPx}px`, maxWidth: `${widthPx}px` },
    children: [
      jsx('div', {
        className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Metrics',
      }),
      // Agent health now renders ABOVE the metric dials (owner request:
      // "swap the agent health and the metrics cards so metrics is on the
      // bottom") — was previously the last child, after all dials.
      jsx(AgentHealthList, { health: agentHealth }),
      jsxs('div', {
        className: 'grid gap-2',
        style: { gridTemplateColumns: `repeat(${dialCols}, minmax(0, 1fr))` },
        children: [
          jsx(MetricDial, {
            label: 'Pending',
            value: pendingCount,
            min: 0,
            max: Math.max(5, pendingCount),
            unit: '',
            subtitle: `${highUrgencyCount} high-urgency`,
          }),
          jsx(MetricDial, {
            label: 'Card coverage',
            value: cardCoverage === null ? 0 : Math.round(cardCoverage * 100),
            min: 0,
            max: 100,
            unit: '%',
            subtitle: cardCoverage === null ? 'no pending rows' : 'rich cards vs plain MCQ',
          }),
          jsx(MetricDial, {
            label: 'Boards gated',
            value: boardsGated,
            min: 0,
            max: Math.max(1, boardsTotal),
            unit: '',
            subtitle: `${boardsGated} / ${boardsTotal} armed`,
          }),
          necessity.error
            ? jsx('div', {
                className: 'text-[0.65rem] text-(--ui-danger,#e5484d)',
                children: 'necessity-rate: error',
              })
            : necessity.rate === null
              ? jsx('div', {
                  className: 'text-center text-[0.65rem] text-(--ui-text-tertiary)',
                  children: `Escalation necessity: n/a (${necessity.marked} marked)`,
                })
              : jsx(MetricDial, {
                  label: 'Escalation necessity',
                  value: Math.round(necessity.rate * 100),
                  min: 0,
                  max: 100,
                  unit: '%',
                  subtitle: `n=${necessity.marked}`,
                }),
        ],
      }),
    ],
  })
}


function DecisionHudPane() {
  const [activeProject, setActiveProject] = React.useState(null)
  const [selectedBoard, setSelectedBoard] = React.useState(null)
  const [resolving, setResolving] = React.useState(false)
  const [gridLayout, setGridLayout] = React.useState(loadGridLayout)
  const [sidebarSettings, setSidebarSettings] = React.useState(loadSidebarSettings)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const { boards, error: boardsError } = useKanbanBoards()

  // The real Kanban<->Decision-HUD cross-link (previously TODO/UI-state-only):
  // both `board.project_id` (hermes-agent core, fixed 2026-09-12 — bind-board
  // now writes it symmetrically) and `decisions.project_id` (this plugin's v6
  // migration, same date) are keys into the SAME projects.db row, so picking a
  // board can drive the decision filter directly instead of being two
  // unrelated selectors that happened to sit next to each other. Board
  // selection wins over the manual ProjectSwitcher when both are set — it's
  // the more specific choice (a project can exist with no bound board, but a
  // bound board always implies exactly one project).
  const selectedBoardProjectId = React.useMemo(() => {
    if (!selectedBoard) return null
    const board = boards.find((b) => b && b.slug === selectedBoard)
    return board ? board.project_id || null : null
  }, [boards, selectedBoard])
  const effectiveProjectId = selectedBoardProjectId || activeProject

  const { decisions, projects, loading, error, refresh } = useDecisionQueue(effectiveProjectId)
  const metrics = useHudMetrics(decisions, boards)
  const agentHealth = useAgentHealth()

  const handleGridChange = React.useCallback((next) => {
    setGridLayout(next)
    saveGridLayout(next)
  }, [])

  const handleSidebarSettingsChange = React.useCallback((next) => {
    setSidebarSettings(next)
    saveSidebarSettings(next)
  }, [])

  const handleResolve = React.useCallback(
    async (id, choice, payload) => {
      haptic('tap')
      setResolving(true)
      try {
        const actorToken = await getActorToken()
        const argv = ['decision', 'resolve', id, choice, '--actor-token', actorToken]
        if (payload) {
          argv.push('--payload', JSON.stringify(payload))
        }
        await cliExec(argv)
        host.notify({ kind: 'success', message: `Resolved: ${choice}` })
        await refresh()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refresh]
  )

  const handleDefer = React.useCallback(
    async (id) => {
      // Deliberately NOT handleResolve: defer never touches
      // resolved_choice/resolved_at, it's a "skip for now" note.
      haptic('tap')
      setResolving(true)
      try {
        await cliExec(['decision', 'defer', id])
        host.notify({ kind: 'success', message: 'Deferred' })
        await refresh()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refresh]
  )

  const metricsSidebar = jsx(MetricsSidebar, {
    metrics, agentHealth,
    side: sidebarSettings.side, widthPx: sidebarSettings.widthPx, dialCols: sidebarSettings.dialCols,
  })
  const mainColumn = jsxs('div', {
    className: 'flex min-w-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'relative flex items-center justify-between',
        children: [
          jsx('div', { className: 'font-medium', children: 'Decision HUD' }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('div', {
                className: 'text-[0.7rem] text-(--ui-text-tertiary)',
                children: loading ? 'refreshing…' : `${decisions.length} pending`,
              }),
              jsx('button', {
                type: 'button',
                'aria-label': 'Settings',
                onClick: () => setSettingsOpen((v) => !v),
                className:
                  'flex h-6 w-6 items-center justify-center rounded border border-(--ui-stroke-secondary) text-[0.8rem] text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary)',
                children: '⚙',
              }),
            ],
          }),
          settingsOpen && jsx(SettingsPopover, {
            layout: gridLayout, onGridChange: handleGridChange,
            sidebarSettings, onSidebarChange: handleSidebarSettingsChange,
          }),
        ],
      }),
      jsx(BoardSelector, { boards, active: selectedBoard, onSelect: setSelectedBoard }),
      jsx(BoardSettingsPanel, { boardSlug: selectedBoard }),
      jsx(ProjectSwitcher, { projects, active: effectiveProjectId, onSelect: (pid) => { setSelectedBoard(null); setActiveProject(pid) } }),
      boardsError
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: boardsError })
        : null,
      error
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error })
        : null,
      jsx('div', {
        className: 'flex flex-1 flex-col overflow-y-auto',
        children:
          decisions.length === 0
            ? jsx('div', {
                className: 'flex h-full items-center justify-center text-(--ui-text-tertiary)',
                children: loading ? 'Loading…' : 'Queue clear.',
              })
            : jsx('div', {
                // Static NxM grid, 1-3 cols x 1-3 rows (user-adjustable via
                // GridLayoutControls above, persisted to localStorage) —
                // "static" means a fixed cell count, not drag-resizable
                // panes. Shows up to cols*rows cards; anything beyond
                // that count stays in the queue and appears once a slot
                // frees up on the next poll/resolve.
                className: 'grid gap-3',
                style: {
                  gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${gridLayout.rows}, auto)`,
                },
                children: decisions
                  .slice(0, gridLayout.cols * gridLayout.rows)
                  .map((d) =>
                    jsx(DecisionCard, { key: d.id, decision: d, onResolve: handleResolve, onDefer: handleDefer, resolving })
                  ),
              }),
      }),
    ],
  })

  return jsxs('div', {
    className: 'flex h-full gap-3 p-3 text-sm',
    // Sidebar renders on whichever side the user picked in settings — left
    // is the historical default (sidebar first in the children array),
    // right means the main column renders first instead.
    children: sidebarSettings.side === 'right'
      ? [mainColumn, metricsSidebar]
      : [metricsSidebar, mainColumn],
  })
}

const PANE_ID = `${PLUGIN_ID}:pane`

export default {
  id: PLUGIN_ID,
  name: 'Decision HUD',
  register(ctx) {
    // Docked pane: registering ONLY on `panes` (never on ROUTES_AREA as the
    // sole surface) is what makes it survive chat/session switching. A page
    // mounted directly on ROUTES_AREA occupies the main content slot, so
    // navigating to any chat session (also a route change) evicts it — the
    // original "why did my Decision HUD disappear" bug. `panes` docks a
    // sibling tab beside the workspace (same mechanism the Kanban Bots pane
    // and the terminal pane use) — it stays mounted, and its poll loop keeps
    // running, no matter which chat session is active or focused.
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Decision HUD',
      data: {
        placement: 'right',
        dock: { pane: 'workspace', pos: 'right' },
        minWidth: '26rem',
      },
      render: () => jsx(DecisionHudPane, {}),
    })
    // Sidebar nav row: SidebarNavContribution requires a real `path` (no
    // onClick escape hatch), and this app's router treats any ROUTES_AREA
    // page as content for the MAIN workspace pane, not a way to front an
    // unrelated docked pane — a route rendering null just reveals whatever
    // chat sits behind it (confirmed live: "click Decision HUD, see a
    // chat"), it does not target the docked pane. So this route renders the
    // real panel too, matching the built-in Kanban page pattern. That means
    // clicking this sidebar row can, for the moment the route is active,
    // run a second DecisionHudPane instance alongside the always-on docked
    // pane (each with its own POLL_MS poll loop) — an acceptable, self-
    // resolving cost (it unmounts the instant you navigate away) against
    // the alternative of a route that doesn't reveal anything.
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/decision-hud' },
      render: () => jsx(DecisionHudPane, {}),
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 55,
      data: { path: '/decision-hud', label: 'Decision HUD', codicon: 'checklist' },
    })
    // Palette command to re-surface the docked pane specifically (e.g. after
    // closing/minimizing its tab) without going through the route at all.
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'decision-hud.open',
        label: 'Decision HUD: Show pane',
        keywords: ['decision', 'hud', 'queue', 'pin', 'pane'],
        run: () => host.revealPane(PANE_ID),
      },
    })
  },
}
