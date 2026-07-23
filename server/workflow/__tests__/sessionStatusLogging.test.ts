import { describe, expect, it } from 'vitest'
import type { SessionStatusStreamEvent } from '../../opencode/types'
import { buildSessionStatusLogEntries } from '../sessionStatusLogging'

describe.concurrent('buildSessionStatusLogEntries', () => {
  it('keeps retry reasons as separate error entries and preserves the status line', () => {
    const event: SessionStatusStreamEvent = {
      type: 'session_status',
      sessionId: 'ses-1',
      status: 'retry',
      attempt: 2,
      message: 'The usage limit has been reached\nPlease try again later.',
      next: 1000,
    }

    expect(buildSessionStatusLogEntries('ses-1', event)).toEqual([
      {
        entryId: 'ses-1:retry:2',
        type: 'error',
        kind: 'error',
        op: 'append',
        content: 'Session retry #2: The usage limit has been reached Please try again later.',
      },
      {
        entryId: 'ses-1:status',
        type: 'info',
        kind: 'session',
        op: 'upsert',
        content: 'Session status: retry (attempt 2).',
      },
    ])
  })

  it('finalizes idle status updates without creating extra error entries', () => {
    const event: SessionStatusStreamEvent = {
      type: 'session_status',
      sessionId: 'ses-1',
      status: 'idle',
    }

    expect(buildSessionStatusLogEntries('ses-1', event)).toEqual([
      {
        entryId: 'ses-1:status',
        type: 'info',
        kind: 'session',
        op: 'finalize',
        content: 'Session status: idle.',
      },
    ])
  })

  it('emits one complete provider recovery error and omits the duplicate generic retry error', () => {
    const event: SessionStatusStreamEvent = {
      type: 'session_status',
      sessionId: 'ses-1',
      status: 'retry',
      attempt: 3,
      message: 'Provider authentication expired.',
      action: {
        provider: 'anthropic',
        reason: 'oauth_expired',
        title: 'Authentication required',
        message: 'Sign in to continue using this provider.',
        label: 'Sign in',
        link: 'https://provider.example/login',
      },
    }

    expect(buildSessionStatusLogEntries('ses-1', event)).toEqual([
      {
        entryId: 'ses-1:provider-action:3',
        type: 'error',
        kind: 'error',
        op: 'append',
        content: 'Provider recovery required (retry #3) for anthropic. Reason: oauth_expired Authentication required: Sign in to continue using this provider. Suggested action: Sign in — https://provider.example/login',
        recoveryAction: event.action,
      },
      {
        entryId: 'ses-1:status',
        type: 'info',
        kind: 'session',
        op: 'upsert',
        content: 'Session status: retry (attempt 3).',
      },
    ])
  })

  it('drops unsafe provider recovery links while retaining the action label', () => {
    const entries = buildSessionStatusLogEntries('ses-1', {
      type: 'session_status',
      sessionId: 'ses-1',
      status: 'busy',
      action: {
        reason: 'authentication',
        label: 'Sign in',
        link: 'javascript:alert(1)',
      },
    })

    expect(entries[0]).toMatchObject({
      kind: 'error',
      content: 'Provider recovery required. Reason: authentication Suggested action: Sign in',
      recoveryAction: {
        reason: 'authentication',
        label: 'Sign in',
      },
    })
    expect(JSON.stringify(entries)).not.toContain('javascript:')
  })
})
