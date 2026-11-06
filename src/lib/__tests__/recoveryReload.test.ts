import { describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_RELOAD_COOLDOWN_MS,
  RECOVERY_RELOAD_DELAY_MS,
} from '@/lib/constants'
import { requestRecoveryReload } from '../recoveryReload'

function createStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_: string, nextValue: string) => {
      value = nextValue
    }),
  }
}

describe('requestRecoveryReload', () => {
  it('schedules a reload and records the recovery source timestamp', () => {
    const storage = createStorage()
    const reload = vi.fn()
    const scheduled: Array<() => void> = []
    const setTimeout = vi.fn((handler: () => void) => {
      scheduled.push(handler)
    })

    expect(requestRecoveryReload('backend-reconnect', {
      now: () => 1_000,
      reload,
      setTimeout,
      storage,
    })).toBe(true)

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), RECOVERY_RELOAD_DELAY_MS)
    expect(storage.setItem).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ at: 1_000, source: 'backend-reconnect' }),
    )
    expect(reload).not.toHaveBeenCalled()

    scheduled[0]?.()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('treats a stored value that is not a reload record as no record', () => {
    // A bare timestamp parses as JSON but has no `at`; text does not parse at all.
    for (const stored of ['1000', 'not a record', '0x3e8']) {
      const reload = vi.fn()
      const setTimeout = vi.fn()

      expect(requestRecoveryReload('backend-reconnect', {
        now: () => 1_000,
        reload,
        setTimeout,
        storage: createStorage(stored),
      })).toBe(true)
      expect(setTimeout).toHaveBeenCalledTimes(1)
    }
  })

  it('suppresses duplicate reload requests inside the cooldown', () => {
    const storage = createStorage()
    const reload = vi.fn()
    const setTimeout = vi.fn()

    expect(requestRecoveryReload('backend-reconnect', {
      now: () => 1_000,
      reload,
      setTimeout,
      storage,
    })).toBe(true)
    expect(requestRecoveryReload('live-updates-reconnect', {
      now: () => 1_000 + RECOVERY_RELOAD_COOLDOWN_MS - 1,
      reload,
      setTimeout,
      storage,
    })).toBe(false)
    expect(requestRecoveryReload('live-updates-reconnect', {
      now: () => 1_000 + RECOVERY_RELOAD_COOLDOWN_MS,
      reload,
      setTimeout,
      storage,
    })).toBe(true)

    expect(setTimeout).toHaveBeenCalledTimes(2)
  })
})
