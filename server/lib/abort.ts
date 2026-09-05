import { CancelledError } from '../council/types'

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || Boolean(signal?.aborted) || isAbortError(error)
}

export function throwIfCancelled(
  error: unknown,
  signal?: AbortSignal,
  ticketId?: number | string,
): void {
  if (isCancellationError(error, signal)) {
    throw new CancelledError(ticketId)
  }
}

/**
 * Stops waiting when the signal aborts.
 *
 * **It does not stop the operation.** The promise passed in keeps running; only
 * the wait for it is abandoned. Pass the signal into the operation as well
 * wherever it accepts one — this is the fallback for a callee that cannot be
 * aborted at all, not a substitute for cancelling one that can.
 */
export async function raceWithCancel<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  ticketId?: number | string,
): Promise<T> {
  if (!signal) return await operation
  if (signal.aborted) throw new CancelledError(ticketId)

  let onAbort: (() => void) | null = null
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError(ticketId))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([operation, abortPromise])
  } catch (error) {
    throwIfCancelled(error, signal, ticketId)
    throw error
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
