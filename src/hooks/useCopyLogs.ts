import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useCopyToClipboard } from './useCopyToClipboard'

/** Export and clipboard feedback belong to the selected scope and filter. */
export function useCopyLogs(targetKey: string, getText: (signal: AbortSignal) => Promise<string>) {
  const [copied, copyToClipboard] = useCopyToClipboard(undefined, targetKey)
  const [state, setState] = useState({ targetKey, pending: false, failures: 0 })
  const controllerRef = useRef<AbortController | null>(null)
  const current = state.targetKey === targetKey
  if (!current) setState({ targetKey, pending: false, failures: 0 })

  // Release the old export before consumers can start the new target during layout.
  useLayoutEffect(() => () => { controllerRef.current?.abort() }, [targetKey])

  const copy = useCallback(async () => {
    if (controllerRef.current && !controllerRef.current.signal.aborted) return
    const controller = new AbortController()
    controllerRef.current = controller
    setState(previous => ({ ...previous, targetKey, pending: true }))
    try {
      const text = await getText(controller.signal)
      if (controller.signal.aborted) return
      if (!text || !await copyToClipboard(text)) throw new Error('Copy failed')
      if (!controller.signal.aborted) setState({ targetKey, pending: false, failures: 0 })
    } catch {
      if (!controller.signal.aborted) {
        setState(previous => ({ targetKey, pending: false, failures: previous.failures + 1 }))
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [copyToClipboard, getText, targetKey])

  return {
    copied: copied && current && state.failures === 0,
    isCopyingLogs: current && state.pending,
    copyLogsFailed: current ? state.failures : 0,
    handleCopyLogs: copy,
  }
}
