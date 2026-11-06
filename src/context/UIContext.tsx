import { useReducer, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { UIContext, type UIState, type UIAction, type TriagePreset, type ErrorStateFilter } from './uiContextDef'
import type { WorkflowGroupId } from '@shared/workflowMeta'

const STORAGE_KEY = 'looptroop-ui-state'
const useBrowserLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Persist the whole UI state (filters, theme, sidebar, and `presetsByProject`) to a
 * single durable localStorage record. React state is the single source of truth, so
 * this is a plain write — no read-back, no per-scope mirror keys, no merge.
 */
function persistUIState(state: UIState): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    // ignore storage errors (private mode, quota, disabled storage)
    return false
  }
}

const defaultState: UIState = {
  selectedTicketId: null,
  selectedTicketExternalId: null,
  sidebarOpen: true,
  activeView: 'kanban',
  logPanelHeight: 300,
  filters: {
    projectId: null,
    status: null,
    phase: null,
    search: '',
    priority: null,
    stuckDays: null,
    errorState: 'none',
    sortBy: 'updatedAt_desc',
    showMocks: true,
  },
  presetsByProject: {},
  theme: 'system',
  showTriageBar: false,
}

const VALID_VIEWS: UIState['activeView'][] = ['kanban', 'ticket']

function normalizeFilters(value: Record<string, unknown> | undefined): UIState['filters'] {
  const merged = {
    ...defaultState.filters,
    ...(value ?? {}),
  } as UIState['filters'] & Record<string, unknown>

  const errorState: ErrorStateFilter =
    merged.errorState === 'past' || merged.errorState === 'blocked' ? merged.errorState : 'none'

  const rawStatus = merged.status
  const status: string[] | null = Array.isArray(rawStatus)
    ? rawStatus.filter((v): v is string => typeof v === 'string')
    : null

  const rawPhase = merged.phase
  const phase: WorkflowGroupId[] | null = Array.isArray(rawPhase)
    ? rawPhase.filter((v): v is WorkflowGroupId => typeof v === 'string')
    : null

  return {
    projectId: typeof merged.projectId === 'number' ? merged.projectId : null,
    status,
    phase,
    search: typeof merged.search === 'string' ? merged.search : defaultState.filters.search,
    priority: Array.isArray(merged.priority)
      ? merged.priority.filter((v): v is number => typeof v === 'number')
      : null,
    stuckDays: typeof merged.stuckDays === 'number' ? merged.stuckDays : null,
    errorState,
    sortBy: typeof merged.sortBy === 'string' ? merged.sortBy : defaultState.filters.sortBy,
    showMocks: typeof merged.showMocks === 'boolean' ? merged.showMocks : true,
  }
}

function normalizePreset(raw: unknown): TriagePreset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  const priority = Array.isArray(p.priority)
    ? p.priority.filter((v): v is number => typeof v === 'number')
    : null
  const stuckDays = typeof p.stuckDays === 'number' ? p.stuckDays : null
  const status = Array.isArray(p.status)
    ? p.status.filter((v): v is string => typeof v === 'string')
    : null
  const phase = Array.isArray(p.phase)
    ? p.phase.filter((v): v is WorkflowGroupId => typeof v === 'string')
    : null
  const errorState: ErrorStateFilter = p.errorState === 'past' || p.errorState === 'blocked' ? p.errorState : 'none'
  const sortBy = typeof p.sortBy === 'string' ? p.sortBy : 'updatedAt_desc'
  const showMocks = typeof p.showMocks === 'boolean' ? p.showMocks : true
  return { priority, stuckDays, status, phase, errorState, sortBy, showMocks }
}

function normalizePresetsByProject(value: unknown): Record<string, Record<string, TriagePreset>> {
  if (typeof value !== 'object' || value === null) return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, Record<string, TriagePreset>> = {}
  for (const [scopeKey, presets] of Object.entries(obj)) {
    if (typeof presets !== 'object' || presets === null) continue
    const normalized: Record<string, TriagePreset> = {}
    for (const [name, preset] of Object.entries(presets as Record<string, unknown>)) {
      const n = normalizePreset(preset)
      if (n) normalized[name] = n
    }
    if (Object.keys(normalized).length) result[scopeKey] = normalized
  }
  return result
}

function normalizeUIState(value: unknown): UIState {
  const obj = typeof value === 'object' && value !== null ? value as Partial<UIState> : {}
  const activeView = VALID_VIEWS.includes(obj.activeView as UIState['activeView'])
    ? obj.activeView
    : defaultState.activeView
  const theme = obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system'
    ? obj.theme
    : defaultState.theme

  return {
    ...defaultState,
    selectedTicketId: typeof obj.selectedTicketId === 'string' ? obj.selectedTicketId : defaultState.selectedTicketId,
    selectedTicketExternalId: typeof obj.selectedTicketExternalId === 'string' ? obj.selectedTicketExternalId : defaultState.selectedTicketExternalId,
    sidebarOpen: typeof obj.sidebarOpen === 'boolean' ? obj.sidebarOpen : defaultState.sidebarOpen,
    activeView: activeView ?? defaultState.activeView,
    logPanelHeight:
      typeof obj.logPanelHeight === 'number' && obj.logPanelHeight >= 100
        ? obj.logPanelHeight
        : defaultState.logPanelHeight,
    filters: normalizeFilters(obj.filters as Record<string, unknown> | undefined),
    presetsByProject: normalizePresetsByProject(obj.presetsByProject),
    theme,
    showTriageBar: typeof obj.showTriageBar === 'boolean' ? obj.showTriageBar : defaultState.showTriageBar,
  }
}

/** The durable record as it stands right now, or null if there isn't a usable one. */
function readStoredUIState(): UIState | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return normalizeUIState(JSON.parse(stored) as unknown)
  } catch {
    return null
  }
}

function getInitialState(): UIState {
  return readStoredUIState() ?? defaultState
}

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'SELECT_TICKET':
      return { ...state, selectedTicketId: action.ticketId, selectedTicketExternalId: action.externalId ?? null, activeView: action.ticketId ? 'ticket' : 'kanban' }
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen }
    case 'SET_LOG_PANEL_HEIGHT':
      return { ...state, logPanelHeight: action.height }
    case 'SET_FILTER':
      return { ...state, filters: normalizeFilters({ ...state.filters, ...action.filter }) }
    case 'SET_PRESETS':
      return { ...state, presetsByProject: { ...state.presetsByProject, [action.presetKey]: action.presets } }
    case 'SET_THEME':
      return { ...state, theme: action.theme }
    case 'CLOSE_TICKET':
      return { ...state, selectedTicketId: null, selectedTicketExternalId: null, activeView: 'kanban' }
    case 'TOGGLE_TRIAGE_BAR':
      return { ...state, showTriageBar: !state.showTriageBar }
    default:
      return state
  }
}


export function UIProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(uiReducer, undefined, getInitialState)

  // Persist committed UI state just before the browser paints, so a saved preset (or any
  // change) survives an immediate refresh. The first render is skipped on purpose: the
  // rehydrated state is already in storage, and unconditionally writing it back on mount was
  // the self-destruct bug that wiped saved presets whenever rehydration produced empty state.
  const hydrated = useRef(false)
  useBrowserLayoutEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true
      return
    }
    persistUIState(state)
  }, [state])

  // No history writing here on purpose. `App` is the only owner of the URL: it
  // routes the modals as well as the ticket, and this provider used to push a
  // pathname derived from `activeView` underneath it. Refreshing `/config`
  // with a ticket selected reopened Configuration *and* had this effect rewrite
  // the pathname to `/ticket/…` beneath it, so Back then had nowhere to go.
  // This provider keeps persistent view state; `App` keeps the URL.

  // Apply theme and listen for system changes
  useEffect(() => {
    const applyTheme = () => {
      const isDark = state.theme === 'dark' ||
        (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', isDark)
    }
    applyTheme()

    if (state.theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      mql.addEventListener('change', applyTheme)
      return () => mql.removeEventListener('change', applyTheme)
    }
  }, [state.theme])

  return (
    <UIContext.Provider value={{ state, dispatch }}>
      {children}
    </UIContext.Provider>
  )
}
