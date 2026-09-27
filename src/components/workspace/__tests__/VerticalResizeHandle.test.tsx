import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerticalResizeHandle } from '../VerticalResizeHandle'

function makeRect(height: number, bottom = height): DOMRect {
  return {
    x: 0,
    y: 0,
    top: bottom - height,
    left: 0,
    bottom,
    right: 0,
    width: 0,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  vi.restoreAllMocks()
})

describe('VerticalResizeHandle', () => {
  it('sizes from the container bottom and clamps both the minimum and maximum', () => {
    const onResize = vi.fn()
    const container = document.createElement('div')
    const containerRef = { current: container }
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(makeRect(500, 800))

    render(<VerticalResizeHandle onResize={onResize} containerRef={containerRef} />)
    const handle = screen.getByRole('separator', { orientation: 'horizontal' })

    fireEvent.mouseDown(handle)
    expect(document.body.style.cursor).toBe('row-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.mouseMove(document, { clientY: 300 })
    fireEvent.mouseMove(document, { clientY: 760 })

    expect(onResize.mock.calls.map(([height]) => height)).toEqual([350, 60])

    fireEvent.mouseUp(document)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    fireEvent.mouseMove(document, { clientY: 500 })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('ignores movement when the container ref is empty', () => {
    const onResize = vi.fn()
    const containerRef: { current: HTMLElement | null } = { current: null }

    render(<VerticalResizeHandle onResize={onResize} containerRef={containerRef} />)
    fireEvent.mouseDown(screen.getByRole('separator', { orientation: 'horizontal' }))
    fireEvent.mouseMove(document, { clientY: 250 })

    expect(onResize).not.toHaveBeenCalled()

    fireEvent.mouseUp(document)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('removes active document listeners and restores styles when unmounted mid-drag', () => {
    const onResize = vi.fn()
    const container = document.createElement('div')
    const containerRef = { current: container }
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(makeRect(500, 600))
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<VerticalResizeHandle onResize={onResize} containerRef={containerRef} />)
    const handle = screen.getByRole('separator', { orientation: 'horizontal' })

    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(document, { clientY: 300 })
    expect(onResize).toHaveBeenCalledWith(300)

    unmount()

    expect(removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    fireEvent.mouseMove(document, { clientY: 320 })
    expect(onResize).toHaveBeenCalledOnce()
  })
})
