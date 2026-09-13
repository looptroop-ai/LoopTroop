import { act, renderHook } from '@testing-library/react'
import { useCallback, useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCopyLogs } from '../useCopyLogs'

afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard') })

it.each(['none', 'failure', 'success'] as const)('settles an empty export after %s without changing the clipboard or reporting a new outcome', async prior => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const load = vi.fn<() => Promise<string>>()
  if (prior === 'failure') load.mockRejectedValueOnce(new Error('Export refused'))
  if (prior === 'success') load.mockResolvedValueOnce('Previous logs.')
  load.mockResolvedValueOnce('').mockResolvedValueOnce('Retry logs.')
  const { result } = renderHook(() => useCopyLogs('ticket:ALL', load))

  if (prior !== 'none') await act(async () => { await result.current.handleCopyLogs() })
  await act(async () => { await result.current.handleCopyLogs() })

  expect(result.current.isCopyingLogs).toBe(false)
  expect(result.current.copied).toBe(false)
  expect(result.current.copyLogsFailed).toBe(prior === 'failure' ? 1 : 0)
  expect(writeText).toHaveBeenCalledTimes(prior === 'success' ? 1 : 0)
  expect(writeText).not.toHaveBeenCalledWith('')

  await act(async () => { await result.current.handleCopyLogs() })
  expect(result.current.copied).toBe(true)
  expect(result.current.copyLogsFailed).toBe(0)
  expect(writeText).toHaveBeenLastCalledWith('Retry logs.')
})

it('aborts the previous export before a layout effect starts copying the new target', async () => {
  let resolveOld!: (text: string) => void
  const oldExport = new Promise<string>(resolve => { resolveOld = resolve })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const load = vi.fn((target: string, _signal: AbortSignal) => target === 'old' ? oldExport : Promise.resolve('Current logs.'))
  const { result, rerender } = renderHook(({ target }) => {
    const getText = useCallback((signal: AbortSignal) => load(target, signal), [target])
    const feedback = useCopyLogs(target, getText)
    const copy = feedback.handleCopyLogs
    useLayoutEffect(() => { void copy() }, [copy])
    return feedback
  }, { initialProps: { target: 'old' } })
  expect(load).toHaveBeenCalledTimes(1)

  rerender({ target: 'new' })
  await act(async () => { await Promise.resolve() })
  expect(load).toHaveBeenCalledTimes(2)
  expect(load.mock.calls[0]![1].aborted).toBe(true)
  expect(load.mock.calls[1]![1].aborted).toBe(false)
  expect(writeText).toHaveBeenCalledExactlyOnceWith('Current logs.')
  expect(result.current.copied).toBe(true)

  await act(async () => { resolveOld('Obsolete logs.'); await oldExport })
  expect(writeText).toHaveBeenCalledTimes(1)
  expect(result.current.copied).toBe(true)
  expect(result.current.isCopyingLogs).toBe(false)
  expect(result.current.copyLogsFailed).toBe(0)
})

it('starts only one export before rerender and ignores its result after unmount', async () => {
  let resolve!: (text: string) => void
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const load = vi.fn((_signal: AbortSignal) => new Promise<string>(done => { resolve = done }))
  const { result, unmount } = renderHook(() => useCopyLogs('ticket:ALL', load))
  let first!: Promise<void>
  act(() => {
    first = result.current.handleCopyLogs()
    void result.current.handleCopyLogs()
  })
  expect(load).toHaveBeenCalledTimes(1)
  unmount()
  expect(load.mock.calls[0]![0].aborted).toBe(true)
  await act(async () => { resolve('Obsolete export.'); await first })
  expect(writeText).not.toHaveBeenCalled()
})
