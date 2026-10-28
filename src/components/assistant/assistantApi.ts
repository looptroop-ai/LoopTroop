import type { AssistantScope, AssistantSession, AssistantSessionSummary, AssistantStreamEvent } from '@shared/assistant'
import { throwIfNotOk } from '@/lib/fetchError'

function scopeQuery(scope: AssistantScope): string {
  const query = new URLSearchParams()
  if (scope.ticketId) query.set('ticketId', scope.ticketId)
  const params = query.toString()
  return params ? `?${params}` : ''
}

function sessionListQuery(scope: AssistantScope): string {
  return scope.ticketId ? scopeQuery(scope) : '?scope=dashboard'
}

function scopeBody(scope: AssistantScope) {
  return scope.ticketId ? { ticketId: scope.ticketId } : {}
}

export async function fetchAssistantSessions(scope: AssistantScope, signal: AbortSignal): Promise<AssistantSessionSummary[]> {
  const response = await fetch(`/api/chat/sessions${sessionListQuery(scope)}`, { signal })
  await throwIfNotOk(response, 'Failed to load assistant conversations')
  return await response.json() as AssistantSessionSummary[]
}

export async function fetchAssistantHistory(signal: AbortSignal): Promise<AssistantSessionSummary[]> {
  const response = await fetch('/api/chat/sessions', { signal })
  await throwIfNotOk(response, 'Failed to load conversation history')
  return await response.json() as AssistantSessionSummary[]
}

export async function createAssistantSession(scope: AssistantScope, signal: AbortSignal): Promise<AssistantSession> {
  const response = await fetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scopeBody(scope)),
    signal,
  })
  await throwIfNotOk(response, 'Failed to start an assistant conversation')
  return await response.json() as AssistantSession
}

export async function fetchAssistantSession(id: string, scope: AssistantScope, signal: AbortSignal): Promise<AssistantSession> {
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}${scopeQuery(scope)}`, { signal })
  await throwIfNotOk(response, 'Failed to open assistant conversation')
  return await response.json() as AssistantSession
}

export async function closeAssistantSession(id: string, scope: AssistantScope, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scopeBody(scope)),
    signal,
  })
  await throwIfNotOk(response, 'Failed to close assistant conversation')
}

export async function sendAssistantMessage(
  id: string,
  message: string,
  scope: AssistantScope,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...scopeBody(scope), message }),
    signal,
  })
  await throwIfNotOk(response, 'Failed to send assistant message')
  if (!response.body) throw new Error('The assistant response had no stream')
  return response
}

function parseFrame(frame: string): AssistantStreamEvent | null {
  const data = frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!data) return null

  const event: unknown = JSON.parse(data)
  if (!event || typeof event !== 'object') throw new Error('Invalid assistant response event')
  const value = event as Record<string, unknown>
  if (value.type === 'delta' && typeof value.text === 'string') return value as AssistantStreamEvent
  if (value.type === 'error' && typeof value.error === 'string') return value as AssistantStreamEvent
  if (value.type === 'done' && value.session && typeof value.session === 'object') return value as AssistantStreamEvent
  throw new Error('Invalid assistant response event')
}

/** Reads SSE data frames even when the network splits them across arbitrary chunks. */
export async function* readAssistantEvents(response: Response, signal: AbortSignal): AsyncGenerator<AssistantStreamEvent> {
  if (!response.body) throw new Error('The assistant response had no stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseFrame(frame)
        if (event) yield event
      }
      if (done) {
        const event = parseFrame(buffer)
        completed = true
        if (event) yield event
        return
      }
      if (signal.aborted) return
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
