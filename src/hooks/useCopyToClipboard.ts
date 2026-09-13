import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { COPY_SUCCESS_DISPLAY_MS } from '@/lib/constants'

/** Copy feedback persists on failure until success or a different logical target. */
export function useCopyToClipboard(displayMs = COPY_SUCCESS_DISPLAY_MS, targetKey?: string) {
  const [feedback, setFeedback] = useState({ targetKey, copied: false, failures: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const attemptRef = useRef(0)

  const copy = useCallback(async (text: string): Promise<boolean> => {
    // Overlapping writes can settle out of order; only the latest controls feedback.
    const attempt = ++attemptRef.current
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      if (attempt === attemptRef.current) {
        clearTimeout(timerRef.current)
        setFeedback((previous) => ({
          targetKey,
          copied: false,
          failures: (previous.targetKey === targetKey ? previous.failures : 0) + 1,
        }))
      }
      return false
    }
    if (attempt !== attemptRef.current) return true
    clearTimeout(timerRef.current)
    setFeedback({ targetKey, copied: true, failures: 0 })
    timerRef.current = setTimeout(() => setFeedback({ targetKey, copied: false, failures: 0 }), displayMs)
    return true
  }, [displayMs, targetKey])

  // Invalidate the old target before a consumer's layout effect can copy the new one.
  useLayoutEffect(() => () => {
    ++attemptRef.current
    clearTimeout(timerRef.current)
  }, [targetKey])

  // Reset during rendering so changing away and back cannot revive old feedback.
  const current = feedback.targetKey === targetKey
  if (!current) setFeedback({ targetKey, copied: false, failures: 0 })
  return [current && feedback.copied, copy, current && feedback.failures > 0, current ? feedback.failures : 0] as const
}
