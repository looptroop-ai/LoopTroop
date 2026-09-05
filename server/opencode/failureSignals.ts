/**
 * One reading of what an OpenCode failure message means.
 *
 * The retry policy and the session-continuation check classified the same
 * strings with their own copies of these patterns, so they could disagree about
 * a single failure: retry treating it as transient while continuation treated
 * it as fatal, or the reverse — and the disagreement decided whether the
 * session was preserved for the next attempt or thrown away.
 *
 * The lists are deliberately word-anchored and flat: no nested quantifiers, so
 * matching stays linear in the length of the message.
 */

/**
 * The failure will not go away by trying again — the request itself is wrong,
 * or the caller is not allowed to make it.
 */
export const PERMANENT_FAILURE_PATTERN = /\b(invalid[_ -]?request|permission|auth|authentication|authenticated|unauthorized|forbidden|credential|api key|token|request[_ -]?too[_ -]?large|payload[_ -]?too[_ -]?large|model[_ -]?not[_ -]?found|provider[_ -]?model[_ -]?not[_ -]?found)\b/

/**
 * Kept separate because the two callers treat it differently: a 402 is a
 * billing problem the continuation path can still resume from, while the retry
 * policy refuses every billing failure outright.
 */
export const BILLING_FAILURE_PATTERN = /\b(billing|insufficient[_ -]?quota)\b/

/** The failure is a rate limit, an outage or a network fault — worth retrying. */
export const TRANSIENT_FAILURE_PATTERN = /\b(rate[_ -]?(?:limit|limited)|too many requests|usage limit|limit (?:has been )?reached|resource exhausted|overloaded|overload|capacity|service unavailable|temporarily unavailable|timeout|timed out|deadline(?: exceeded)?|fetch failed|connection reset|socket reset|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network)\b/

export function looksPermanentFailure(text: string): boolean {
  return PERMANENT_FAILURE_PATTERN.test(text)
}

export function looksBillingFailure(text: string): boolean {
  return BILLING_FAILURE_PATTERN.test(text)
}

export function looksTransientFailure(text: string): boolean {
  return TRANSIENT_FAILURE_PATTERN.test(text)
}
