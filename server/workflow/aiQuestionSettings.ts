/**
 * Whether a run may stop and ask, and how long the question waits.
 *
 * Its own module rather than a function on `phases/helpers.ts` because
 * `runOpenCodePrompt` resolves it, and that module sits far below the phase
 * helpers. Everything about this answer is per ticket, so the ticket is the only
 * argument.
 */

import { db as appDb } from '../db/index'
import { profiles } from '../db/schema'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { getTicketContext } from '../storage/ticketQueries'
import { clampAiQuestionWindowMs } from '@shared/aiQuestions'

export interface AiQuestionSettings {
  enabled: boolean
  windowMs: number
}

/**
 * A started ticket reads only what was frozen at its start.
 *
 * Editing the profile at 3 a.m. must not change what an overnight run does
 * mid-flight, so the locked columns win outright once `startedAt` is set. A
 * started ticket with nothing locked began before this setting existed and may
 * not ask at all — a run already in progress should not silently gain the
 * ability to stop.
 */
export function resolveAiQuestionSettings(ticketId: string | undefined): AiQuestionSettings {
  const fallback: AiQuestionSettings = {
    enabled: false,
    windowMs: clampAiQuestionWindowMs(PROFILE_DEFAULTS.aiQuestionWindow),
  }
  if (!ticketId) return fallback

  const context = getTicketContext(ticketId)
  if (!context?.localTicket) return fallback
  const ticket = context.localTicket

  if (ticket.startedAt !== null) {
    return {
      enabled: ticket.lockedAiQuestionsEnabled === true,
      windowMs: clampAiQuestionWindowMs(ticket.lockedAiQuestionWindow),
    }
  }

  const profile = appDb.select().from(profiles).get()
  return {
    // `??` rather than `||`: `false` is a real override, not an absent one.
    enabled: ticket.aiQuestionsOverride
      ?? context.localProject.aiQuestionsOverride
      ?? profile?.aiQuestionsEnabled
      ?? PROFILE_DEFAULTS.aiQuestionsEnabled,
    windowMs: clampAiQuestionWindowMs(
      ticket.aiQuestionWindowOverride
        ?? context.localProject.aiQuestionWindowOverride
        ?? profile?.aiQuestionWindow
        ?? PROFILE_DEFAULTS.aiQuestionWindow,
    ),
  }
}

/** Shorthand for the permission boundary, which only needs the boolean. */
export function ticketAllowsAiQuestions(ticketId: string | undefined): boolean {
  return resolveAiQuestionSettings(ticketId).enabled
}
