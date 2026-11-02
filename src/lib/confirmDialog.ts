import type { ReactNode } from 'react'

/**
 * The app's replacement for `window.confirm` and `window.alert`: the same one-call,
 * promise-shaped API, drawn in the app's own theme instead of the browser's chrome.
 *
 * A module-level request rather than a context, so it can be called from plain
 * functions and document listeners as well as components. `ConfirmDialogHost` (in
 * `components/shared/ConfirmDialog.tsx`) must be mounted once (App does it); without
 * a host a request never settles.
 */
export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` paints the confirm button red: discarding work, deleting things. */
  tone?: 'danger' | 'default'
}

export interface PendingConfirm extends ConfirmOptions {
  /** An alert has one button and always settles `true`. */
  alert: boolean
  resolve: (confirmed: boolean) => void
}

let pending: PendingConfirm | null = null
const listeners = new Set<() => void>()

function setPending(next: PendingConfirm | null) {
  pending = next
  for (const listener of listeners) listener()
}

function request(options: ConfirmOptions, alert: boolean): Promise<boolean> {
  // Only one question can be on screen. A newer one answers the older with "no",
  // which is what dismissing it would have done.
  pending?.resolve(false)
  return new Promise((resolve) => {
    setPending({ ...options, alert, resolve })
  })
}

/** Resolves `true` when the user confirms, `false` on cancel, Escape, or a click outside. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return request(options, false)
}

/** Resolves once the user has dismissed the message. */
export async function alertDialog(options: Omit<ConfirmOptions, 'cancelLabel'>): Promise<void> {
  await request(options, true)
}

export function settleConfirm(confirmed: boolean) {
  const current = pending
  if (!current) return
  setPending(null)
  current.resolve(confirmed)
}

export function subscribeConfirm(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getPendingConfirm = () => pending

/** The one "you will lose edits" question, so every window words its buttons alike. */
export function confirmDiscardChanges(message: string): Promise<boolean> {
  return confirmDialog({
    title: 'Discard unsaved changes?',
    message,
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    tone: 'danger',
  })
}
