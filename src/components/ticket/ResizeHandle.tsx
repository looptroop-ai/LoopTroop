import { useCallback, useEffect, useRef } from 'react'
import { clampNavWidth } from './navWidth'

interface ResizeHandleProps {
  onResize: (width: number) => void
  /** Called once with the final width when the drag ends, for callers that persist it. */
  onResizeEnd?: (width: number) => void
}

export function ResizeHandle({ onResize, onResizeEnd }: ResizeHandleProps) {
  const isDragging = useRef(false)
  const lastWidthRef = useRef<number | null>(null)
  const listenersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)

  // Clean up listeners on unmount
  useEffect(() => {
    return () => {
      if (listenersRef.current) {
        document.removeEventListener('mousemove', listenersRef.current.move)
        document.removeEventListener('mouseup', listenersRef.current.up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [])

  const handleMouseDown = useCallback(() => {
    isDragging.current = true
    lastWidthRef.current = null
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const width = clampNavWidth(e.clientX)
      lastWidthRef.current = width
      onResize(width)
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      listenersRef.current = null
      if (lastWidthRef.current !== null) onResizeEnd?.(lastWidthRef.current)
      lastWidthRef.current = null
    }

    listenersRef.current = { move: handleMouseMove, up: handleMouseUp }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [onResize, onResizeEnd])

  return (
    <div
      className="w-1 cursor-col-resize bg-border hover:bg-primary/50 transition-colors flex-shrink-0"
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}
