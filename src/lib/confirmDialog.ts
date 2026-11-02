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
  /** Distinct per request, so the host remounts and refocuses for each one. */
  id: number
  /** An alert has one button and always settles `true`. */
  alert: boolean
  resolve: (confirmed: boolean) => void
}

// The head of the queue is on screen. Only alerts ever wait in it: a message must be
// read, while a question is only worth answering in the context that asked it.
let queue: PendingConfirm[] = []
let nextId = 0
const listeners = new Set<() => void>()

function setQueue(next: PendingConfirm[]) {
  queue = next
  for (const listener of listeners) listener()
}

/** Answers every open question with "no", as dismissing it would. Alerts stay. */
export function cancelConfirmQuestions() {
  const questions = queue.filter((entry) => !entry.alert)
  if (questions.length === 0) return
  setQueue(queue.filter((entry) => entry.alert))
  for (const question of questions) question.resolve(false)
}

function request(options: ConfirmOptions, alert: boolean): Promise<boolean> {
  // A newer question replaces an older one, which gets "no".
  cancelConfirmQuestions()
  return new Promise((resolve) => {
    setQueue([...queue, { ...options, id: ++nextId, alert, resolve }])
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

/** Answers whatever is on screen. */
export function settleConfirm(confirmed: boolean) {
  const [current, ...rest] = queue
  if (!current) return
  setQueue(rest)
  current.resolve(current.alert || confirmed)
}

export function subscribeConfirm(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getPendingConfirm = (): PendingConfirm | null => queue[0] ?? null

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
