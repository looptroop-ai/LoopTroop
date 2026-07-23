import { useState, useCallback, useRef, useEffect } from 'react'
import { COPY_SUCCESS_DISPLAY_MS } from '@/lib/constants'

/**
 * Hook for copy-to-clipboard with a transient "copied" indicator.
 * Returns [isCopied, copy] where copy accepts the text to copy.
 */
export function useCopyToClipboard(displayMs = COPY_SUCCESS_DISPLAY_MS) {
  const [isCopied, setIsCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const copy = useCallback(
    async (text: string) => {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setIsCopied(false), displayMs)
    },
    [displayMs],
  )

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return [isCopied, copy] as const
}
