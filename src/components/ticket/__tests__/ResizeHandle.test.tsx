import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from '../ResizeHandle'

const originalInnerWidth = window.innerWidth

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
})

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  vi.restoreAllMocks()
})

describe('ResizeHandle', () => {
  it('clamps drag widths, reports the final width, and restores document styles', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()

    render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />)
    const handle = screen.getByRole('separator', { orientation: 'vertical' })

    fireEvent.mouseDown(handle)
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.mouseMove(document, { clientX: 120 })
    fireEvent.mouseMove(document, { clientX: 900 })

    expect(onResize.mock.calls.map(([width]) => width)).toEqual([200, 500])

    fireEvent.mouseUp(document)

    expect(onResizeEnd).toHaveBeenCalledOnce()
    expect(onResizeEnd).toHaveBeenCalledWith(500)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    fireEvent.mouseMove(document, { clientX: 350 })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('does not persist a width when the pointer is released without moving', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()

    render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />)
    fireEvent.mouseDown(screen.getByRole('separator', { orientation: 'vertical' }))
    fireEvent.mouseUp(document)

    expect(onResize).not.toHaveBeenCalled()
    expect(onResizeEnd).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('removes active document listeners and restores styles when unmounted mid-drag', () => {
    const onResize = vi.fn()
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<ResizeHandle onResize={onResize} />)
    const handle = screen.getByRole('separator', { orientation: 'vertical' })

    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(document, { clientX: 320 })
    expect(onResize).toHaveBeenCalledWith(320)

    unmount()

    expect(removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    fireEvent.mouseMove(document, { clientX: 450 })
    expect(onResize).toHaveBeenCalledOnce()
  })
})
