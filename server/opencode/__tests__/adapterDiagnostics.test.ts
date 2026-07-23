import { describe, expect, it } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import type { GenericMessagePart, StreamEvent } from '../types'

interface AdapterInternals {
  mapPartUpdate(part: GenericMessagePart): StreamEvent | null
  normalizeStreamEvent(
    event: { type: string; properties?: Record<string, unknown> },
    sessionId: string,
    partCache: Map<string, GenericMessagePart>,
    finalizedPartIds: Set<string>,
    messageRoles: Map<string, string>,
  ): StreamEvent | null
}

function createAdapterInternals(): AdapterInternals {
  return new OpenCodeSDKAdapter('http://localhost:4096', {} as never) as unknown as AdapterInternals
}

describe.concurrent('OpenCode diagnostic event mapping', () => {
  it('maps tool duration, compaction time, and safe attachment metadata without payload URLs', () => {
    const event = createAdapterInternals().mapPartUpdate({
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'completed',
        time: {
          start: 1000,
          end: 2350,
          compacted: 2500,
        },
        attachments: [
          {
            filename: 'report.json',
            mime: 'application/json',
            url: 'data:application/json;base64,secret-payload',
          },
          {
            name: 'notes.txt',
            mediaType: 'text/plain',
            source: '/private/path/notes.txt',
          },
        ],
      },
    } as GenericMessagePart)

    expect(event).toMatchObject({
      type: 'tool',
      durationMs: 1350,
      compactedAt: 2500,
      attachments: [
        { filename: 'report.json', mime: 'application/json' },
        { filename: 'notes.txt', mime: 'text/plain' },
      ],
    })
    expect(JSON.stringify(event)).not.toContain('secret-payload')
    expect(JSON.stringify(event)).not.toContain('/private/path')
  })

  it('preserves provider recovery fields and rejects unsafe action links', () => {
    const internal = createAdapterInternals()
    const mapStatus = (link: string) => internal.normalizeStreamEvent({
      type: 'session.status',
      properties: {
        status: {
          type: 'retry',
          attempt: 2,
          message: 'Authentication required',
          action: {
            provider: 'anthropic',
            reason: 'oauth_expired',
            title: 'Sign in again',
            message: 'Your provider session expired.',
            label: 'Open provider login',
            link,
          },
        },
      },
    }, 'session-1', new Map(), new Set(), new Map())

    expect(mapStatus('https://provider.example/login')).toMatchObject({
      type: 'session_status',
      action: {
        provider: 'anthropic',
        reason: 'oauth_expired',
        title: 'Sign in again',
        message: 'Your provider session expired.',
        label: 'Open provider login',
        link: 'https://provider.example/login',
      },
    })
    expect(mapStatus('javascript:alert(1)')).toMatchObject({
      type: 'session_status',
      action: {
        provider: 'anthropic',
        reason: 'oauth_expired',
        title: 'Sign in again',
        message: 'Your provider session expired.',
        label: 'Open provider login',
      },
    })
    expect(JSON.stringify(mapStatus('javascript:alert(1)'))).not.toContain('javascript:')
  })
})
