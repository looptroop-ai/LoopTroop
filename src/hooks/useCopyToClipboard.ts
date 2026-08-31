import { useState, useCallback, useRef, useEffect } from 'react'
import { COPY_SUCCESS_DISPLAY_MS } from '@/lib/constants'

/**
 * Hook for copy-to-clipboard with a transient "copied" indicator.
 * Returns [isCopied, copy] where copy accepts the text to copy and resolves to
 * whether the write succeeded.
 *
 * The clipboard is refusable — a denied permission, or any page not served from a
 * secure context — and the rejection used to travel no further than the console
 * while the button sat there looking like it had worked.
 */
export function useCopyToClipboard(displayMs = COPY_SUCCESS_DISPLAY_MS) {
  const [isCopied, setIsCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // A refusal has to retract the previous success, not just decline to add one:
        // copying twice in a row, the second time denied, otherwise leaves the first
        // copy's tick on screen for the rest of its timer, reporting the failure as a
        // success.
        clearTimeout(timerRef.current)
        setIsCopied(false)
        return false
      }
      setIsCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setIsCopied(false), displayMs)
      return true
    },
    [displayMs],
  )

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return [isCopied, copy] as const
}
