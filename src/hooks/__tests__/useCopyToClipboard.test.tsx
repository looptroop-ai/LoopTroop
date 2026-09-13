import { act, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
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
  vi.useRealTimers()
})

/**
 * The clipboard is refusable — a denied permission, or any page not served from a
 * secure context. The rejection used to travel no further than an unhandled promise,
 * so the button reported success it had not had.
 */
describe('useCopyToClipboard', () => {
  it.each([true, false])('retains feedback for a new target copied during layout (success: %s)', async success => {
    const writeText = stubClipboard(() => success ? Promise.resolve() : Promise.reject(new Error('Denied')))
    const { result, rerender } = renderHook(({ target }) => {
      const feedback = useCopyToClipboard(undefined, target)
      const copy = feedback[1]
      useLayoutEffect(() => { void copy(target) }, [copy, target])
      return feedback
    }, { initialProps: { target: 'first-target' } })
    await waitFor(() => { expect(result.current[success ? 0 : 2]).toBe(true) })

    rerender({ target: 'second-target' })
    await waitFor(() => { expect(result.current[success ? 0 : 2]).toBe(true) })

    expect(writeText).toHaveBeenLastCalledWith('second-target')
    expect(result.current[0]).toBe(success)
    expect(result.current[2]).toBe(!success)
    expect(result.current[3]).toBe(success ? 0 : 1)
  })

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
    expect(result.current[2]).toBe(false)
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
    expect(result.current[2]).toBe(true)
  })

  it('does not reject, so a call site is free to ignore the result', async () => {
    stubClipboard(() => Promise.reject(new Error('Document is not focused.')))
    const { result } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await expect(result.current[1]('copy me')).resolves.toBe(false)
    })
  })

  it('retracts a previous success when the next write is refused', async () => {
    let allow = true
    stubClipboard(() => (allow ? Promise.resolve() : Promise.reject(new Error('Write permission denied.'))))
    const { result } = renderHook(() => useCopyToClipboard())

    await act(async () => { await result.current[1]('first') })
    expect(result.current[0]).toBe(true)

    allow = false
    await act(async () => { await result.current[1]('second') })

    // The tick from the first copy would otherwise sit there for the rest of its
    // timer, reporting the refusal as a success.
    expect(result.current[0]).toBe(false)
    expect(result.current[2]).toBe(true)
  })

  it('ignores a refusal that settles after a later success', async () => {
    let rejectFirst: (reason: Error) => void = () => {}
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject }))
      .mockImplementationOnce(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { result } = renderHook(() => useCopyToClipboard())

    let first: Promise<boolean> | undefined
    await act(async () => { first = result.current[1]('first') })
    await act(async () => { await result.current[1]('second') })
    expect(result.current[0]).toBe(true)

    // The earlier attempt loses its race and must not take down the later tick.
    await act(async () => {
      rejectFirst(new Error('Write permission denied.'))
      await first
    })

    expect(result.current[0]).toBe(true)
    expect(result.current[2]).toBe(false)
  })

  it('keeps failure visible until a successful retry, including when the clipboard API is unavailable', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCopyToClipboard(100))

    await act(async () => { await result.current[1]('first') })
    expect(result.current[2]).toBe(true)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current[2]).toBe(true)

    stubClipboard(() => Promise.resolve())
    await act(async () => { await result.current[1]('retry') })
    expect(result.current[0]).toBe(true)
    expect(result.current[2]).toBe(false)
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current[0]).toBe(false)
  })

  it('ignores a success that settles after a later refusal', async () => {
    let resolveFirst: () => void = () => {}
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve }))
      .mockRejectedValueOnce(new Error('Write permission denied.'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { result } = renderHook(() => useCopyToClipboard())

    let first: Promise<boolean> | undefined
    await act(async () => { first = result.current[1]('first') })
    await act(async () => { await result.current[1]('second') })
    await act(async () => { resolveFirst(); await first })

    expect(result.current[0]).toBe(false)
    expect(result.current[2]).toBe(true)
  })

  it('resets on target change and ignores a pending write from the previous target', async () => {
    let rejectCopy: (reason: Error) => void = () => {}
    stubClipboard(() => new Promise((_, reject) => { rejectCopy = reject }))
    const { result, rerender } = renderHook(({ target }) => useCopyToClipboard(undefined, target), {
      initialProps: { target: 'bead-a' },
    })
    let pending: Promise<boolean> | undefined
    await act(async () => { pending = result.current[1]('old logs') })
    rerender({ target: 'bead-b' })
    await act(async () => { rejectCopy(new Error('Denied')); await pending })
    expect(result.current[2]).toBe(false)

    stubClipboard(() => Promise.reject(new Error('Denied')))
    await act(async () => { await result.current[1]('new logs') })
    expect(result.current[2]).toBe(true)
    expect(result.current[3]).toBe(1)
    await act(async () => { await result.current[1]('new logs') })
    expect(result.current[3]).toBe(2)
    rerender({ target: 'bead-a' })
    expect(result.current[2]).toBe(false)
    rerender({ target: 'bead-b' })
    expect(result.current[2]).toBe(false)
  })

})
