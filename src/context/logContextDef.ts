import { createContext } from 'react'
import type { LogActionsValue, LogStateValue } from './logUtils'

/**
 * The log context is two contexts on purpose.
 *
 * A single provider value is a new object on every render, and the provider
 * re-renders on every streamed log line. Anything listing the context in a
 * dependency array therefore re-ran per line — including the effects that ask
 * the server for a phase's logs, which turned one arriving line into another
 * request for the page it belongs to. Memoising the value does not help while
 * the readers inside it close over `logsByPhase`.
 *
 * So the rows live in `LogStateContext` and the callbacks in
 * `LogActionsContext`, and the callbacks keep one identity for the life of the
 * provider. Subscribe to the actions to load or append; subscribe to the state
 * as well when you draw rows.
 */
export const LogStateContext = createContext<LogStateValue | null>(null)
export const LogActionsContext = createContext<LogActionsValue | null>(null)
