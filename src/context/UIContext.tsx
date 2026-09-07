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

  // Legacy migration: the pre-tri-state binary `onlyErrors: true` becomes `errorState: 'blocked'`.
  let errorState: ErrorStateFilter =
    merged.errorState === 'past' || merged.errorState === 'blocked' ? merged.errorState : 'none'
  if (merged.onlyErrors === true) errorState = 'blocked'

  // Legacy migration: `status` was a single string in older persisted state; only arrays are kept.
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

const LEGACY_PRESET_KEY_PREFIX = 'looptroop-presets-'

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
  let errorState: ErrorStateFilter = 'none'
  if (p.errorState === 'past' || p.errorState === 'blocked') errorState = p.errorState
  else if (p.onlyErrors === true) errorState = 'blocked' // legacy migration
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

/**
 * The legacy keys this page load actually pulled presets out of. They are deleted once
 * — and only once — the merged blob has been written back successfully; see
 * `UIProvider`. Module scope because `getInitialState` produces them during
 * `useReducer` initialisation, where there is nowhere else to put them.
 */
let pendingLegacyPresetKeys: string[] = []

/**
 * Retires the keys the merge read from. Called only after a write that succeeded, from
 * whichever persistence got there first: if the migration's own write is refused, the
 * keys stay pending, and the next ordinary state change that reaches storage clears
 * them. Without that second chance a deletion made after a failed write would be
 * undone by the legacy key on the following load.
 */
function retireMigratedLegacyKeys(): void {
  if (pendingLegacyPresetKeys.length === 0) return
  const keys = pendingLegacyPresetKeys
  // A key storage refuses to remove stays pending. Dropping it here would leave it on
  // disk with nothing left to retry it, and the next load would merge it back in —
  // resurrecting a preset the user deletes in the meantime.
  const failed: string[] = []
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      failed.push(key)
    }
  }
  pendingLegacyPresetKeys = failed
}

/**
 * One-time, init-only recovery of legacy per-scope `looptroop-presets-*` localStorage keys
 * into `UIState.presetsByProject`. Runs once per page load from `getInitialState` (never on
 * write), so presets that only survived in these standalone keys — e.g. because an earlier
 * build wiped the durable blob — are pulled back in. The blob wins on conflict.
 *
 * The keys it read are reported back so they can be removed after the merge has been
 * persisted. Leaving them in place made deletion impossible to express: a preset the user
 * deleted from the blob was copied back out of its legacy key on the very next load, and
 * came back from the dead however many times it was deleted.
 */
function migrateLegacyPresets(existing: Record<string, Record<string, TriagePreset>>): {
  presetsByProject: Record<string, Record<string, TriagePreset>>
  migratedKeys: string[]
} {
  if (typeof window === 'undefined') return { presetsByProject: existing, migratedKeys: [] }
  const merged: Record<string, Record<string, TriagePreset>> = { ...existing }
  const migratedKeys: string[] = []

  // Enumerating storage is itself refusable — a browser set to block site data throws
  // on the accessor, not just on a read — and this runs during `useReducer`
  // initialisation, where an exception means the provider never mounts and the app
  // renders nothing at all. Per-key guards stay inside, for malformed entries.
  let legacyKeys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LEGACY_PRESET_KEY_PREFIX)) legacyKeys.push(key)
    }
  } catch {
    legacyKeys = []
  }

  for (const key of legacyKeys) {
    try {
      const stored = localStorage.getItem(key)
      if (!stored) continue
      const parsed = JSON.parse(stored) as unknown
      const normalized: Record<string, TriagePreset> = {}
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [name, preset] of Object.entries(parsed as Record<string, unknown>)) {
          const n = normalizePreset(preset)
          if (n) normalized[name] = n
        }
      }
      if (Object.keys(normalized).length) {
        merged[key] = { ...normalized, ...(merged[key] ?? {}) }
        migratedKeys.push(key)
      }
    } catch {
      // ignore migration errors for individual keys; legacy presets that are malformed simply won't be carried over
    }
  }
  return { presetsByProject: merged, migratedKeys }
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
  const initialState = readStoredUIState() ?? defaultState
  const { presetsByProject, migratedKeys } = migrateLegacyPresets(initialState.presetsByProject)
  pendingLegacyPresetKeys = migratedKeys
  return { ...initialState, presetsByProject }
}

/**
 * Writes the recovered presets into whatever the durable record says *now*, rather
 * than into the copy this tab rehydrated from.
 *
 * Every other write in this provider replaces the record wholesale, and a second tab
 * losing the change it made a moment ago is recoverable — it can make it again. This
 * one is not: it is immediately followed by deleting the legacy keys, so a stale
 * overwrite here destroys the last copy of something. Re-reading costs one
 * `getItem` on mount and removes that.
 */
function persistMigratedPresets(state: UIState): boolean {
  const stored = readStoredUIState()
  if (!stored) return persistUIState(state)

  const presetsByProject = { ...stored.presetsByProject }
  for (const key of pendingLegacyPresetKeys) {
    const recovered = state.presetsByProject[key]
    if (!recovered) continue
    // The durable record still wins on a name conflict, exactly as the merge does.
    presetsByProject[key] = { ...recovered, ...(presetsByProject[key] ?? {}) }
  }
  return persistUIState({ ...stored, presetsByProject })
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
    if (persistUIState(state)) retireMigratedLegacyKeys()
  }, [state])

  /**
   * Finish the legacy migration: write the merged blob, and only if that write went
   * through, remove the keys it came from.
   *
   * The order is the whole point. Deleting during initialisation — while the first
   * persistence effect above is deliberately skipped — would destroy the only copy of
   * a user's presets if the tab closed before anything triggered a write.
   *
   * A write that fails (quota, private mode, storage disabled) leaves the keys where
   * they are *and leaves them pending*, so the next successful persistence retires
   * them instead. Dropping them here would have let a later write record a deletion
   * while the legacy key that resurrects it stayed on disk.
   *
   * Runs on mount only, and only when something was actually migrated, so this is not
   * the unconditional write-back that once wiped presets whenever rehydration produced
   * empty state: by construction the state written here carries the recovered presets.
   * It writes the live state rather than a mount-time copy, so it stays correct if
   * anything ever dispatches before it runs.
   */
  const liveStateRef = useRef(state)
  useEffect(() => {
    liveStateRef.current = state
  })
  useEffect(() => {
    if (pendingLegacyPresetKeys.length === 0) return
    if (persistMigratedPresets(liveStateRef.current)) retireMigratedLegacyKeys()
  }, [])

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
