import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCopyToClipboard } from '../useCopyToClipboard'

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  })
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

/**
 * The clipboard is refusable — a denied permission, or any page not served from a
 * secure context. The rejection used to travel no further than an unhandled promise,
 * so the button reported success it had not had.
 */
describe('useCopyToClipboard', () => {
  it('reports success and shows the copied state', async () => {
    const writeText = stubClipboard(() => Promise.resolve())
    const { result } = renderHook(() => useCopyToClipboard())

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current[1]('copy me')
    })

    expect(writeText).toHaveBeenCalledWith('copy me')
    expect(outcome).toBe(true)
    expect(result.current[0]).toBe(true)
  })

  it('reports failure and leaves the copied state alone when the write is refused', async () => {
    stubClipboard(() => Promise.reject(new Error('Write permission denied.')))
    const { result } = renderHook(() => useCopyToClipboard())

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current[1]('copy me')
    })

    expect(outcome).toBe(false)
    expect(result.current[0]).toBe(false)
  })

  it('does not reject, so a call site is free to ignore the result', async () => {
    stubClipboard(() => Promise.reject(new Error('Document is not focused.')))
    const { result } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await expect(result.current[1]('copy me')).resolves.toBe(false)
    })
  })
})
