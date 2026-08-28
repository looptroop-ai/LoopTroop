/**
 * Unattended AI question handling — the shared contract.
 *
 * LoopTroop runs unattended. OpenCode's `question` tool contradicts that: it
 * stops a run and waits for a person, indefinitely. This module holds the rules
 * both halves of the app need to agree on — who may ask, how long the wait may
 * be, and what a timer looks like once it is on the wire.
 */

import { WORKFLOW_PHASES } from './workflowMeta'

/** Shortest wait a person can configure. One minute. */
export const AI_QUESTION_WINDOW_MIN_MS = 60_000
/** Longest wait a person can configure. One hour. */
export const AI_QUESTION_WINDOW_MAX_MS = 3_600_000
/** What a fresh install waits before the question refuses itself. */
export const AI_QUESTION_WINDOW_DEFAULT_MS = 300_000

/**
 * The statuses that run the interview.
 *
 * The interview produces its own questions and has its own surface for them.
 * Letting a model raise `question` there would put two unrelated kinds of
 * question on screen at once, so the interview is excluded whatever the setting
 * says. Derived from the workflow group rather than listed by hand: a status
 * added to the interview later is covered without anyone remembering to.
 */
export const INTERVIEW_QUESTION_PHASES: ReadonlySet<string> = new Set(
  WORKFLOW_PHASES.filter((phase) => phase.groupId === 'interview').map((phase) => phase.id),
)

/** False for the interview, true for every other workflow step. */
export function phaseMayAskQuestions(phase: string | null | undefined): boolean {
  if (!phase) return false
  return !INTERVIEW_QUESTION_PHASES.has(phase)
}

/** Where a setting in force came from, once the cascade has been resolved. */
export type SettingSource = 'profile' | 'project' | 'ticket'

/**
 * The countdown, as it travels to the browser.
 *
 * One per status, shared by every model asking in it. `serverNow` is what lets
 * the browser correct for clock skew without ever owning the clock itself: the
 * deadline is the server's, and closing the tab does not pause it.
 */
export interface AiQuestionTimerState {
  /** `<phase>:<attempt>` — the status the countdown belongs to. */
  timerKey: string
  windowMs: number
  armedAt: string
  deadlineAt: string
  /** Set once a person has engaged. A stopped timer never expires. */
  stoppedAt: string | null
  stoppedBy: string | null
  /** How many times a new model asking pushed the clock back to full. */
  resetCount: number
  /** Bumped on every transition, so a late SSE frame cannot undo a newer one. */
  revision: number
  /** The server's clock at the moment this was built. */
  serverNow: string
}

/** Clamps a configured wait to the range the UI offers. */
export function clampAiQuestionWindowMs(windowMs: number | null | undefined): number {
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs)) return AI_QUESTION_WINDOW_DEFAULT_MS
  return Math.min(AI_QUESTION_WINDOW_MAX_MS, Math.max(AI_QUESTION_WINDOW_MIN_MS, Math.round(windowMs)))
}

/** "5 minutes", "90 seconds" — the wait as a person reads it. */
export function formatAiQuestionWindow(windowMs: number): string {
  const totalSeconds = Math.round(windowMs / 1000)
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} second${seconds === 1 ? '' : 's'}`
  return `${minutes}m ${seconds}s`
}

export function buildAiQuestionTimerKey(phase: string, phaseAttempt: number): string {
  return `${phase}:${phaseAttempt}`
}
