import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_GRACE_MS,
  INITIAL_LIVENESS_STATE,
  LOOPTROOP_DEV_BACKEND_GRACE_MS,
  nextLivenessState,
  resolveGraceMs,
  shouldDeclareDead,
  type LivenessState,
} from '../scripts/dev-backend-liveness'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Drives a sequence of probes through the state machine. */
function run(probes: Array<{ reachable: boolean, nowMs: number }>): LivenessState {
  return probes.reduce(nextLivenessState, INITIAL_LIVENESS_STATE)
}

describe('nextLivenessState', () => {
  it('records the first success as "has been ready"', () => {
    expect(run([{ reachable: true, nowMs: 1_000 }]))
      .toEqual({ everReady: true, unreachableSinceMs: null })
  })

  it('starts the clock on the first failure and does not restart it', () => {
    // Restarting the clock on every failing probe would push the deadline out
    // forever, so the backend could be gone indefinitely without being noticed.
    const state = run([
      { reachable: true, nowMs: 1_000 },
      { reachable: false, nowMs: 2_000 },
      { reachable: false, nowMs: 3_000 },
      { reachable: false, nowMs: 4_000 },
    ])

    expect(state.unreachableSinceMs).toBe(2_000)
  })

  it('clears the clock when the backend answers again', () => {
    const state = run([
      { reachable: true, nowMs: 1_000 },
      { reachable: false, nowMs: 2_000 },
      { reachable: true, nowMs: 3_000 },
    ])

    expect(state).toEqual({ everReady: true, unreachableSinceMs: null })
  })
})

describe('shouldDeclareDead', () => {
  it('stays silent before the backend has ever answered', () => {
    // A first boot can be slow on a cold cache. Killing the stack for being
    // slow to start would be its own bug.
    const state = run([
      { reachable: false, nowMs: 0 },
      { reachable: false, nowMs: 600_000 },
    ])

    expect(shouldDeclareDead(state, { nowMs: 900_000, graceMs: DEFAULT_GRACE_MS })).toBe(false)
  })

  it('stays silent while the backend is answering', () => {
    const state = run([{ reachable: true, nowMs: 1_000 }])

    expect(shouldDeclareDead(state, { nowMs: 999_000, graceMs: DEFAULT_GRACE_MS })).toBe(false)
  })

  it('tolerates a restart, which is the common case', () => {
    // Every file save restarts the backend. Declaring it dead for that would
    // tear the stack down constantly.
    const state = run([
      { reachable: true, nowMs: 0 },
      { reachable: false, nowMs: 1_000 },
    ])

    expect(shouldDeclareDead(state, { nowMs: 11_000, graceMs: DEFAULT_GRACE_MS })).toBe(false)
  })

  it('declares death once the silence outlasts the grace period', () => {
    const state = run([
      { reachable: true, nowMs: 0 },
      { reachable: false, nowMs: 1_000 },
    ])

    expect(shouldDeclareDead(state, { nowMs: 61_000, graceMs: DEFAULT_GRACE_MS })).toBe(true)
  })

  it('fires exactly at the deadline, not a probe later', () => {
    const state = run([
      { reachable: true, nowMs: 0 },
      { reachable: false, nowMs: 1_000 },
    ])

    expect(shouldDeclareDead(state, { nowMs: 60_999, graceMs: DEFAULT_GRACE_MS })).toBe(false)
    expect(shouldDeclareDead(state, { nowMs: 61_000, graceMs: DEFAULT_GRACE_MS })).toBe(true)
  })

  it('forgives a recovered blip, so a flap never accumulates toward death', () => {
    const state = run([
      { reachable: true, nowMs: 0 },
      { reachable: false, nowMs: 1_000 },
      { reachable: true, nowMs: 2_000 },
      { reachable: false, nowMs: 3_000 },
    ])

    // The clock restarted at 3_000, so the earlier blip contributes nothing.
    expect(shouldDeclareDead(state, { nowMs: 62_000, graceMs: DEFAULT_GRACE_MS })).toBe(false)
  })
})

describe('resolveGraceMs', () => {
  it('defaults when unset', () => {
    expect(resolveGraceMs({})).toBe(DEFAULT_GRACE_MS)
    expect(resolveGraceMs({ [LOOPTROOP_DEV_BACKEND_GRACE_MS]: '  ' })).toBe(DEFAULT_GRACE_MS)
  })

  it('accepts a positive override', () => {
    expect(resolveGraceMs({ [LOOPTROOP_DEV_BACKEND_GRACE_MS]: '15000' })).toBe(15_000)
  })

  it('refuses values that would declare death on the first blip', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    for (const value of ['0', '-1', 'soon', 'NaN']) {
      expect(resolveGraceMs({ [LOOPTROOP_DEV_BACKEND_GRACE_MS]: value }), value).toBe(DEFAULT_GRACE_MS)
    }

    expect(warn).toHaveBeenCalledTimes(4)
  })
})
