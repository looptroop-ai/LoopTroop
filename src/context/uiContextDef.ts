import { createContext } from 'react'
import type { WorkflowGroupId } from '@shared/workflowMeta'

/**
 * A saved Kanban triage filter/sort configuration.
 *
 * Presets are persisted as part of `UIState` (via the `looptroop-ui-state`
 * localStorage channel) and are scoped per project (or globally when no
 * project filter is active). `projectId` and `search` are intentionally
 * excluded: `projectId` is the preset's scope key, and `search` is transient.
 */
export interface TriagePreset {
  priority: number[] | null
  stuckDays: number | null
  status: string[] | null
  phase: WorkflowGroupId[] | null
  errorState: 'none' | 'past' | 'blocked'
  sortBy: string
  showMocks: boolean
}

/** Tri-state error filter for the Kanban triage bar. */
export type ErrorStateFilter = 'none' | 'past' | 'blocked'

export interface UIState {
  selectedTicketId: string | null
  selectedTicketExternalId: string | null
  sidebarOpen: boolean
  /**
   * Which of the two root surfaces is showing. Modals are not views: they are
   * routes owned by `App`, which is the only writer of `window.history`.
   */
  activeView: 'kanban' | 'ticket'
  logPanelHeight: number
  filters: {
    projectId: number | null
    /** Multi-select of workflow status IDs (e.g. CODING, DRAFT). `null` = no status filter. */
    status: string[] | null
    /** Multi-select of workflow group IDs (e.g. interview, prd, implementation). `null` = no phase filter. */
    phase: WorkflowGroupId[] | null
    search: string
    priority: number[] | null
    stuckDays: number | null
    /** Tri-state error filter replacing the legacy binary `onlyErrors`. */
    errorState: ErrorStateFilter
    sortBy: string
    showMocks: boolean
  }
  /** Per-scope Kanban triage presets, keyed by `looptroop-presets-${projectId}` or `looptroop-presets-global`. */
  presetsByProject: Record<string, Record<string, TriagePreset>>
  theme: 'light' | 'dark' | 'system'
  showTriageBar: boolean
}

export type UIAction =
  | { type: 'SELECT_TICKET'; ticketId: string | null; externalId?: string | null }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_LOG_PANEL_HEIGHT'; height: number }
  | { type: 'SET_FILTER'; filter: Partial<UIState['filters']> }
  | { type: 'SET_PRESETS'; presetKey: string; presets: Record<string, TriagePreset> }
  | { type: 'SET_THEME'; theme: UIState['theme'] }
  | { type: 'CLOSE_TICKET' }
  | { type: 'TOGGLE_TRIAGE_BAR' }

export interface UIContextValue {
  state: UIState
  dispatch: React.Dispatch<UIAction>
}

export const UIContext = createContext<UIContextValue | null>(null)
