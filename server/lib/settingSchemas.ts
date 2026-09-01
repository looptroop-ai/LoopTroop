import { z } from 'zod'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS } from '@shared/aiQuestions'
import { GIT_HOOK_POLICIES } from '@shared/gitHookPolicy'
import { IGNORE_MODES } from '@shared/ignoreMode'

/**
 * Zod fragments for settings that are validated in more than one place.
 *
 * The same field is validated at the ticket route, the project route, the
 * profile route and again at the storage boundary. Written out at each, they
 * drift silently: a bound tightened in one place leaves the others accepting
 * what it now rejects, and the disagreement only surfaces as a confusing error
 * from whichever layer happens to be stricter. These live in `lib/` rather than
 * beside any one of those callers so storage does not have to import a route
 * module to reuse them.
 */

/** The configured AI-question wait, in milliseconds. */
export const aiQuestionWindowSchema = z.number().int()
  .min(AI_QUESTION_WINDOW_MIN_MS)
  .max(AI_QUESTION_WINDOW_MAX_MS)

/** The same value as an override. Null is how an override is cleared back to inheriting. */
export const aiQuestionWindowOverrideSchema = aiQuestionWindowSchema.nullable().optional()

export const gitHookPolicySchema = z.enum(GIT_HOOK_POLICIES)

export const ignoreModeSchema = z.enum(IGNORE_MODES)

/** Ticket content accepted identically on create and update. */
export const ticketContentFields = {
  description: z.string().max(50000).optional(),
  priority: z.number().int().min(1).max(5).optional(),
}

/**
 * Per-ticket overrides, accepted identically on create and update.
 *
 * All three are nullable: null clears the override so the ticket inherits from
 * its project again.
 */
export const ticketOverrideFields = {
  manualQaOverride: z.boolean().nullable().optional(),
  aiQuestionsOverride: z.boolean().nullable().optional(),
  aiQuestionWindowOverride: aiQuestionWindowOverrideSchema,
}
