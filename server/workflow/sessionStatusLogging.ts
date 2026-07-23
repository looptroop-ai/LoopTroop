import type { OpenCodeProviderAction, SessionStatusStreamEvent } from '../opencode/types'

export interface SessionStatusLogEntry {
  entryId: string
  type: 'info' | 'error'
  kind: 'session' | 'error'
  op: 'append' | 'upsert' | 'finalize'
  content: string
  recoveryAction?: OpenCodeProviderAction
}

function normalizeStatusMessage(message?: string): string | null {
  if (!message) return null
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeRecoveryAction(action?: OpenCodeProviderAction): OpenCodeProviderAction | null {
  if (!action) return null
  const normalize = (value?: string) => normalizeStatusMessage(value) ?? undefined
  let link: string | undefined
  if (action.link) {
    try {
      const url = new URL(action.link)
      if (url.protocol === 'http:' || url.protocol === 'https:') link = url.toString()
    } catch {
      link = undefined
    }
  }
  const normalized = {
    ...(normalize(action.reason) ? { reason: normalize(action.reason) } : {}),
    ...(normalize(action.provider) ? { provider: normalize(action.provider) } : {}),
    ...(normalize(action.title) ? { title: normalize(action.title) } : {}),
    ...(normalize(action.message) ? { message: normalize(action.message) } : {}),
    ...(normalize(action.label) ? { label: normalize(action.label) } : {}),
    ...(link ? { link } : {}),
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

function formatRecoveryAction(action: OpenCodeProviderAction, attempt?: number): string {
  const prefix = typeof attempt === 'number'
    ? `Provider recovery required (retry #${attempt})`
    : 'Provider recovery required'
  const provider = action.provider ? ` for ${action.provider}` : ''
  const detail = action.title && action.message
    ? `${action.title}: ${action.message}`
    : action.title ?? action.message
  const reason = action.reason ? `Reason: ${action.reason}` : undefined
  const suggestion = action.label
    ? `Suggested action: ${action.label}${action.link ? ` — ${action.link}` : ''}`
    : action.link
      ? `Recovery link: ${action.link}`
      : undefined
  return [`${prefix}${provider}.`, reason, detail, suggestion].filter(Boolean).join(' ')
}

export function buildSessionStatusLogEntries(
  sessionId: string,
  event: SessionStatusStreamEvent,
): SessionStatusLogEntry[] {
  const entries: SessionStatusLogEntry[] = []
  const recoveryAction = normalizeRecoveryAction(event.action)

  if (recoveryAction) {
    entries.push({
      entryId: `${sessionId}:provider-action:${event.attempt ?? event.status}`,
      type: 'error',
      kind: 'error',
      op: 'append',
      content: formatRecoveryAction(recoveryAction, event.attempt),
      recoveryAction,
    })
  } else if (event.status === 'retry') {
    const retryLabel = typeof event.attempt === 'number'
      ? `Session retry #${event.attempt}`
      : 'Session retry'
    const retryMessage = normalizeStatusMessage(event.message)

    entries.push({
      entryId: `${sessionId}:retry:${event.attempt}`,
      type: 'error',
      kind: 'error',
      op: 'append',
      content: retryMessage ? `${retryLabel}: ${retryMessage}` : `${retryLabel}.`,
    })
  }

  const attemptSuffix = event.status === 'retry' && typeof event.attempt === 'number'
    ? ` (attempt ${event.attempt})`
    : ''

  entries.push({
    entryId: `${sessionId}:status`,
    type: 'info',
    kind: 'session',
    op: event.status === 'idle' ? 'finalize' : 'upsert',
    content: `Session status: ${event.status}${attemptSuffix}.`,
  })

  return entries
}
