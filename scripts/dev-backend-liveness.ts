export const LOOPTROOP_DEV_BACKEND_GRACE_MS = 'LOOPTROOP_DEV_BACKEND_GRACE_MS'

/**
 * A normal watch restart takes a few seconds. The grace period has to clear
 * that comfortably, because declaring the backend dead while it is merely
 * restarting would tear the stack down on every file save.
 */
export const DEFAULT_GRACE_MS = 60_000

export interface LivenessState {
  /** Until the backend has answered once, there is nothing to compare against. */
  everReady: boolean
  /** When it stopped answering, or null while it is answering. */
  unreachableSinceMs: number | null
}

export const INITIAL_LIVENESS_STATE: LivenessState = {
  everReady: false,
  unreachableSinceMs: null,
}

export function nextLivenessState(
  previous: LivenessState,
  probe: { reachable: boolean, nowMs: number },
): LivenessState {
  if (probe.reachable) return { everReady: true, unreachableSinceMs: null }

  return {
    everReady: previous.everReady,
    // The first failing probe is what starts the clock; later ones must not
    // restart it, or the deadline would never arrive.
    unreachableSinceMs: previous.unreachableSinceMs ?? probe.nowMs,
  }
}

/**
 * Whether the backend should be treated as gone rather than restarting.
 *
 * Deliberately silent until the backend has answered at least once: a first
 * boot can take a long time on a cold cache or a slow disk, and killing the
 * stack for being slow to start would be its own bug. Once it has answered,
 * a long silence means something the watcher will not recover from.
 */
export function shouldDeclareDead(
  state: LivenessState,
  options: { nowMs: number, graceMs: number },
): boolean {
  if (!state.everReady) return false
  if (state.unreachableSinceMs === null) return false
  return options.nowMs - state.unreachableSinceMs >= options.graceMs
}

/**
 * Grace period from the environment, falling back to the default.
 *
 * A zero or negative value would declare the backend dead on its first blip,
 * so anything not a positive finite number is refused rather than obeyed.
 */
export function resolveGraceMs(
  env: Partial<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[LOOPTROOP_DEV_BACKEND_GRACE_MS]?.trim()
  if (!raw) return DEFAULT_GRACE_MS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[dev-backend] Ignoring ${LOOPTROOP_DEV_BACKEND_GRACE_MS}="${raw}": expected a positive number of milliseconds.`,
    )
    return DEFAULT_GRACE_MS
  }

  return parsed
}
