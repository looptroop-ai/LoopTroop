import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKEND_HEALTH_RECONNECT_CONFIRMATION_PROBES,
  BACKEND_HEALTH_POLL_MS,
  BACKEND_HEALTH_RECONNECT_GRACE_MS,
} from '@/lib/constants'
import { useBackendHealth } from '../useBackendHealth'

const pingDevBackendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/devApi', () => ({
  pingDevBackend: pingDevBackendMock,
}))

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useBackendHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pingDevBackendMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not mark the backend offline before the first successful connection', async () => {
    pingDevBackendMock.mockResolvedValue(false)

    const { result } = renderHook(() => useBackendHealth())

    await flushPromises()

    expect(pingDevBackendMock).toHaveBeenCalledTimes(1)
    expect(result.current.isOffline).toBe(false)

    await advanceTimers(BACKEND_HEALTH_POLL_MS)

    expect(pingDevBackendMock).toHaveBeenCalledTimes(2)
    expect(result.current.isOffline).toBe(false)
  })

  it('ignores one transient failed probe after the backend has connected', async () => {
    pingDevBackendMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const { result } = renderHook(() => useBackendHealth())

    await flushPromises()
    expect(result.current.isOffline).toBe(false)

    await advanceTimers(BACKEND_HEALTH_POLL_MS)
    expect(result.current.isOffline).toBe(false)
    expect(pingDevBackendMock).toHaveBeenCalledTimes(2)

    await advanceTimers(BACKEND_HEALTH_RECONNECT_GRACE_MS)

    expect(pingDevBackendMock).toHaveBeenCalledTimes(3)
    expect(result.current.isOffline).toBe(false)
  })

  it('marks the backend offline only after one grace-delayed retry also fails', async () => {
    pingDevBackendMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)

    const { result } = renderHook(() => useBackendHealth())

    await flushPromises()
    await advanceTimers(BACKEND_HEALTH_POLL_MS)
    await advanceTimers(BACKEND_HEALTH_RECONNECT_GRACE_MS * (BACKEND_HEALTH_RECONNECT_CONFIRMATION_PROBES - 1))
    expect(result.current.isOffline).toBe(false)
    await advanceTimers(BACKEND_HEALTH_RECONNECT_GRACE_MS)

    expect(result.current.isOffline).toBe(true)
  })

  it('clears offline state when a later health probe succeeds', async () => {
    pingDevBackendMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const { result } = renderHook(() => useBackendHealth())

    await flushPromises()
    await advanceTimers(BACKEND_HEALTH_POLL_MS)
    await advanceTimers(BACKEND_HEALTH_RECONNECT_GRACE_MS * BACKEND_HEALTH_RECONNECT_CONFIRMATION_PROBES)
    expect(result.current.isOffline).toBe(true)

    await advanceTimers(BACKEND_HEALTH_POLL_MS)

    expect(result.current.isOffline).toBe(false)
  })
})
