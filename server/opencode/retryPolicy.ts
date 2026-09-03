import { db as appDb } from '../db/index'
import { profiles } from '../db/schema'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { looksBillingFailure, looksPermanentFailure, looksTransientFailure } from './failureSignals'

export interface OpenCodeRetryPolicy {
  limit: number
  delayMs: number
}

const MAX_OPENCODE_RETRY_LIMIT = 50
const MAX_OPENCODE_RETRY_DELAY_MS = 3_600_000

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const normalized = Math.trunc(value)
  if (normalized < min) return min
  if (normalized > max) return max
  return normalized
}

export function normalizeOpenCodeRetryPolicy(input?: Partial<OpenCodeRetryPolicy> | null): OpenCodeRetryPolicy {
  return {
    limit: clampInteger(input?.limit, PROFILE_DEFAULTS.opencodeRetryLimit, 0, MAX_OPENCODE_RETRY_LIMIT),
    delayMs: clampInteger(input?.delayMs, PROFILE_DEFAULTS.opencodeRetryDelay, 0, MAX_OPENCODE_RETRY_DELAY_MS),
  }
}

export function resolveOpenCodeRetryPolicy(input?: Partial<OpenCodeRetryPolicy> | null): OpenCodeRetryPolicy {
  if (input) return normalizeOpenCodeRetryPolicy(input)

  try {
    const profile = appDb.select().from(profiles).get()
    return normalizeOpenCodeRetryPolicy({
      limit: profile?.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit,
      delayMs: profile?.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay,
    })
  } catch {
    return normalizeOpenCodeRetryPolicy()
  }
}

/**
 * Shares its patterns with the session-continuation check, which used to carry
 * its own copies — so the two could disagree about a single failure, and the
 * disagreement decided whether the session survived for the next attempt.
 *
 * Every billing failure is refused here, unconditionally; the continuation path
 * makes an exception for a 402, which it can see and this cannot.
 */
export function isContinuableOpenCodeRetryMessage(message: string | undefined | null): boolean {
  const normalized = message?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  if (looksPermanentFailure(normalized) || looksBillingFailure(normalized)) return false
  return looksTransientFailure(normalized)
}
