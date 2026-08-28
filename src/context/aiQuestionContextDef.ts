import { createContext } from 'react'
import type { AiQuestionTimerState } from '@shared/aiQuestions'

export interface AiQuestionOption {
  label: string
  description?: string
}

export interface AiQuestionInfo {
  question: string
  header: string
  options: AiQuestionOption[]
  /** Checkboxes instead of radio buttons. */
  multiple?: boolean
  /** A free-text answer is accepted. Absent means yes. */
  custom?: boolean
}

/** One model's batch of questions. Several can share a step, and a countdown. */
export interface AiQuestionRequest {
  ticketId: string
  ticketExternalId: string
  ticketTitle: string
  status: string
  phase: string
  phaseAttempt?: number
  modelId?: string
  sessionId: string
  requestId: string
  questions: AiQuestionInfo[]
  receivedAt: string
  submitting: boolean
  error?: string
}

export interface AIQuestionContextValue {
  /** Individual questions waiting on this ticket, across every model asking. */
  getPendingCount: (ticketId: string) => number
  /** Models asking. A council of three asking two things each is 3, not 6. */
  getRequestCount: (ticketId: string) => number
  getTicketRequests: (ticketId: string) => AiQuestionRequest[]
  getTimer: (ticketId: string) => AiQuestionTimerState | null
  /**
   * Remaining milliseconds, corrected for clock skew, or null when there is no
   * countdown to show — no timer, or one a person has already stopped.
   */
  getRemainingMs: (ticketId: string) => number | null
  answerRequest: (ticketId: string, requestId: string, answers: string[][]) => void
  skipRequest: (ticketId: string, requestId: string, reason: string | null) => void
  /**
   * A person is dealing with this, so the clock stops — for good, and for every
   * model in the step. Safe to call on every keystroke; it posts once.
   */
  stopTimer: (ticketId: string) => void
  /** Feeds a `needs_input` SSE frame in. Ignores anything that is not a question. */
  ingestSseEvent: (data: Record<string, unknown>) => void
  /** Pulls this ticket's questions now, rather than waiting for the next poll. */
  refreshTicket: (ticketId: string) => void
}

export const AIQuestionContext = createContext<AIQuestionContextValue>({
  getPendingCount: () => 0,
  getRequestCount: () => 0,
  getTicketRequests: () => [],
  getTimer: () => null,
  getRemainingMs: () => null,
  answerRequest: () => undefined,
  skipRequest: () => undefined,
  stopTimer: () => undefined,
  ingestSseEvent: () => undefined,
  refreshTicket: () => undefined,
})
