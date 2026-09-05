import type { OpenCodeAdapter } from './adapter'
import type { HealthStatus, OpenCodeSessionCreateOptions, Session } from './types'
import {
  OPENCODE_SESSION_CREATE_HEALTH_DIAGNOSTIC_TIMEOUT_MS,
  OPENCODE_SESSION_CREATE_RETRY_DELAYS_MS,
} from '../lib/constants'
import { getErrorMessage } from '@shared/typeGuards'

export interface OpenCodeSessionCreateRetryOptions {
  retryDelaysMs?: readonly number[]
  healthDiagnosticTimeoutMs?: number
}

// Differs from `@shared/typeGuards`'s `getErrorMessage` on purpose: an Error thrown with an
// empty message would leave the retry diagnostic blank, so fall back to `String(error)`.
function describeSessionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return getErrorMessage(error)
  return String(error)
}

function getAbortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException('Aborted', 'AbortError')
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof Error && error.name === 'AbortError')
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getAbortReason(signal))
  if (delayMs <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let settled = false
    let onAbort: (() => void) | undefined
    const timer = setTimeout(() => finish(resolve), delayMs)
    function finish(callback: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      callback()
    }
    if (signal) {
      onAbort = () => finish(() => reject(getAbortReason(signal)))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function raceWithAbortAndTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw getAbortReason(signal)
  if (timeoutMs <= 0) return await operation

  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupt = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('health check timed out')), timeoutMs)
    if (signal) {
      onAbort = () => reject(getAbortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    return await Promise.race([operation, interrupt])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function formatHealthDiagnostic(health: HealthStatus): string {
  if (!health.available) {
    return `unavailable${health.error ? `: ${health.error}` : ''}`
  }
  const details = [
    health.version ? `version ${health.version}` : undefined,
    health.models ? `${health.models.length} model(s)` : undefined,
  ].filter(Boolean)
  return details.length > 0 ? `available (${details.join(', ')})` : 'available'
}

async function collectHealthDiagnostic(
  adapter: OpenCodeAdapter,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  try {
    const health = await raceWithAbortAndTimeout(adapter.checkHealth(signal), signal, timeoutMs)
    return formatHealthDiagnostic(health)
  } catch (error) {
    if (isAbortLike(error, signal)) throw error
    return `health check failed: ${describeSessionError(error)}`
  }
}

function buildRetryError(errors: unknown[], lastHealthDiagnostic: string | undefined): Error {
  const attempts = errors.length
  const attemptDetails = errors
    .map((error, index) => `attempt ${index + 1}: ${describeSessionError(error)}`)
    .join(' | ')
  const healthDetails = lastHealthDiagnostic
    ? ` Last OpenCode health check: ${lastHealthDiagnostic}.`
    : ''
  return new Error(`Failed to create OpenCode session after ${attempts} attempts. ${attemptDetails}.${healthDetails}`)
}

export async function createOpenCodeSessionWithRetry(
  adapter: OpenCodeAdapter,
  projectPath: string,
  signal?: AbortSignal,
  createOptions?: OpenCodeSessionCreateOptions,
  retryOptions: OpenCodeSessionCreateRetryOptions = {},
): Promise<Session> {
  const retryDelaysMs = retryOptions.retryDelaysMs ?? OPENCODE_SESSION_CREATE_RETRY_DELAYS_MS
  const healthDiagnosticTimeoutMs = retryOptions.healthDiagnosticTimeoutMs
    ?? OPENCODE_SESSION_CREATE_HEALTH_DIAGNOSTIC_TIMEOUT_MS
  const errors: unknown[] = []
  let lastHealthDiagnostic: string | undefined

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (signal?.aborted) throw getAbortReason(signal)

    try {
      return await adapter.createSession(projectPath, signal, createOptions)
    } catch (error) {
      if (isAbortLike(error, signal)) throw error
      errors.push(error)
      const retryDelayMs = retryDelaysMs[attempt]
      if (retryDelayMs === undefined) {
        lastHealthDiagnostic = await collectHealthDiagnostic(adapter, signal, healthDiagnosticTimeoutMs)
        break
      }

      const [healthDiagnostic] = await Promise.all([
        collectHealthDiagnostic(adapter, signal, healthDiagnosticTimeoutMs),
        waitForRetryDelay(retryDelayMs, signal),
      ])
      lastHealthDiagnostic = healthDiagnostic
    }
  }

  throw buildRetryError(errors, lastHealthDiagnostic)
}
