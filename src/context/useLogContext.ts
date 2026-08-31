import { useContext, useMemo } from 'react'
import { LogActionsContext, LogStateContext } from './logContextDef'
import type { LogActionsValue, LogContextValue, LogStateValue } from './logUtils'

/** Rows, readers and loading flags. Re-renders the caller on every streamed line. */
export function useLogState(): LogStateValue | null {
  return useContext(LogStateContext)
}

/**
 * Callbacks only, with identities stable for the life of the provider. Use this
 * where a component appends or requests logs but never draws them — depending on
 * it does not re-render the caller when a line arrives.
 */
export function useLogActions(): LogActionsValue | null {
  return useContext(LogActionsContext)
}

/**
 * Both halves, for the components that draw rows and so re-render per line
 * anyway. The identity changes exactly when the rows do, which is what a memo
 * over `getLogsForPhase` needs to recompute.
 */
export function useLogs(): LogContextValue | null {
  const state = useLogState()
  const actions = useLogActions()
  return useMemo(
    () => (state && actions ? { ...state, ...actions } : null),
    [actions, state],
  )
}
