import { describe, expect, it } from 'vitest'
import {
  createV2EventMappingState,
  isV2QuestionForm,
  mapV2Event,
  mapV2Message,
  mapV2PermissionRules,
  mapV2PromptParts,
  mapV2Question,
  mapV2QuestionAnswer,
  mapV2Session,
} from '../v2Mapping'

describe('OpenCode v2 mapping edge cases', () => {
  it('maps incomplete messages and tool parts without losing safe metadata', () => {
    expect(mapV2Message(null)).toBeNull()
    expect(mapV2Message({ id: 'message-1', type: 'user' })).toBeNull()
    expect(mapV2Message({ id: 1, type: 'assistant', sessionID: 'session-1' })).toBeNull()

    const message = mapV2Message({
      id: 'assistant-1',
      type: 'assistant',
      sessionID: 'session-1',
      time: { created: 0, completed: 'invalid' },
      content: [
        null,
        {},
        { type: 'text', text: 'visible', synthetic: true, ignored: true, time: { created: 3, completed: 7 }, state: { source: 'wire' } },
        { type: 'reasoning', text: 'thinking', time: { created: 8 } },
        {
          type: 'tool',
          id: 'call-1',
          name: 'bash',
          state: {
            status: 'streaming',
            input: { command: 'pwd' },
            title: 'Run command',
            content: [{ type: 'text', text: 'done' }, { type: 'file', name: 'report.log', mime: 'text/plain' }],
            error: { message: 'warning' },
            metadata: { source: 'test' },
            time: { created: 10, ran: 11, completed: 15 },
            raw: 'raw tool state',
          },
          metadata: { visible: true },
        },
        { type: 'tool', state: 'not an object' },
        { type: 'custom-part', custom: 'retained' },
      ],
    })

    expect(message).toMatchObject({
      id: 'assistant-1',
      timestamp: '1970-01-01T00:00:00.000Z',
      parts: [
        { type: 'text', text: 'visible', synthetic: true, ignored: true, time: { start: 3, end: 7 }, metadata: { source: 'wire' } },
        { type: 'reasoning', text: 'thinking', time: { start: 8 } },
        {
          type: 'tool',
          callID: 'call-1',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: 'pwd' },
            title: 'Run command',
            output: 'done',
            error: 'warning',
            metadata: { source: 'test' },
            time: { start: 11, end: 15 },
            attachments: [{ filename: 'report.log', mime: 'text/plain' }],
            raw: 'raw tool state',
          },
          metadata: { visible: true },
        },
        { type: 'tool', callID: 'assistant-1:5', tool: 'tool', state: { status: 'pending' } },
        { type: 'custom-part', custom: 'retained' },
      ],
    })
    expect(message?.content).toBeUndefined()
    expect(mapV2Message({ id: 'assistant-without-session', type: 'assistant' }, 'fallback-session')?.info?.sessionID)
      .toBe('fallback-session')
    expect(mapV2Message({ id: 'synthetic-1', type: 'synthetic', sessionID: 'session-1', text: 'system message' })?.role)
      .toBe('system')
  })

  it('filters malformed question fields and validates answer cardinality', () => {
    expect(isV2QuestionForm(null)).toBe(false)
    expect(isV2QuestionForm({ metadata: { kind: 'approval' } })).toBe(false)
    expect(mapV2Question({ id: 'form-1', sessionID: 'session-1', metadata: { kind: 'approval' }, fields: [] })).toBeNull()
    expect(mapV2Question({ id: 'form-1', sessionID: 'session-1', metadata: { kind: 'question' }, fields: [] })).toBeNull()

    const form = {
      id: 'form-edge',
      sessionID: 'session-1',
      metadata: { kind: 'question', tool: { messageID: 'assistant-1', callID: 'call-1' } },
      fields: [
        null,
        { type: 'external', key: 'external' },
        { type: 'string', key: 'free', description: 'Free response' },
        { type: 'string', key: 'closed', title: 'Choose', options: [null, {}, { label: 'Missing value' }, { label: 'One', value: 'one', description: 'First option' }], custom: false },
        { type: 'multiselect', key: 'many', title: 'Many', custom: false },
      ],
    }

    expect(mapV2Question(form)).toMatchObject({
      id: 'form-edge',
      tool: { messageID: 'assistant-1', callID: 'call-1' },
      questions: [
        { question: 'Free response', header: 'Question', custom: true, options: [] },
        { question: 'Choose', header: 'Choose', custom: false, options: [{ label: 'One', value: 'one', description: 'First option' }] },
        { question: 'Many', multiple: true, custom: false },
      ],
    })
    expect(mapV2QuestionAnswer(form, [['answer'], ['one'], ['north', 'south']])).toEqual({
      free: 'answer',
      closed: 'one',
      many: ['north', 'south'],
    })
    expect(mapV2QuestionAnswer({
      metadata: { kind: 'question' },
      fields: [{ type: 'string' }, { type: 'multiselect' }],
    }, [[], ['a']])).toEqual({ q1: ['a'] })
    expect(() => mapV2QuestionAnswer({ metadata: { kind: 'approval' }, fields: [] }, []))
      .toThrow('not a pending question')
    expect(() => mapV2QuestionAnswer(form, [['a'], ['b'], ['c'], ['too many']]))
      .toThrow('answer count exceeds')
    expect(() => mapV2QuestionAnswer(form, [['first', 'second']]))
      .toThrow('single-select question free received multiple answers')
  })

  it('maps tool lifecycle events, malformed inputs, and question cleanup', () => {
    const state = createV2EventMappingState()
    const map = (type: string, data: unknown) => mapV2Event({ type, data: { sessionID: 'session-1', ...(data as object) } }, 'session-1', state)

    expect(map(null as unknown as string, {})).toBeNull()
    expect(mapV2Event({ type: 'session.execution.started', data: {} }, 'session-1')).toBeNull()
    expect(mapV2Event({ type: 'session.execution.started', data: {} }, 'session-1', state, true))
      .toMatchObject({ event: { type: 'execution_started', sessionId: 'session-1' } })
    expect(mapV2Event({ type: 'session.execution.started', data: { sessionID: 'other' } }, 'session-1')).toBeNull()

    expect(map('session.tool.input.started', { id: 'call-1' })).toBeNull()
    expect(map('session.tool.input.started', { assistantMessageID: 'assistant-1', id: 'call-1', name: 'bash' }))
      .toMatchObject({ event: { type: 'tool', status: 'pending', callId: 'call-1', title: 'bash' } })
    expect(map('session.tool.input.delta', { id: 'call-1', delta: '{"command":' }))
      .toMatchObject({ event: { input: { raw: '{"command":' } } })
    expect(map('session.tool.input.delta', { id: 'call-1', delta: '"pwd"}' }))
      .toMatchObject({ event: { input: { command: 'pwd' }, tool: 'bash' } })
    expect(map('session.tool.input.ended', { id: 'call-1', text: '{bad json' }))
      .toMatchObject({ event: { input: { raw: '{bad json' }, title: undefined } })
    expect(map('session.tool.called', { id: 'call-1' }))
      .toMatchObject({ event: { status: 'running', input: { raw: '{bad json' } } })
    expect(map('session.tool.called', { id: 'other-call', input: ['not', 'an object'] }))
      .toMatchObject({ event: { tool: 'other-call', input: {} } })
    expect(map('session.tool.progress', { id: 'call-1', metadata: { progress: 50 } }))
      .toMatchObject({ event: { status: 'running', metadata: { progress: 50 } } })
    expect(map('session.tool.progress', { id: 'unknown-call' }))
      .toMatchObject({ event: { tool: 'unknown-call', input: {} } })
    expect(map('session.tool.success', {
      id: 'call-1',
      content: [{ type: 'text', text: 'ok' }, { type: 'file', name: 'log.txt', mime: 'text/plain' }, null],
      metadata: { exitCode: 0 },
    })).toMatchObject({ event: { status: 'completed', output: 'ok', attachments: [{ filename: 'log.txt', mime: 'text/plain' }] } })
    expect(state.toolNames.has('call-1')).toBe(false)
    expect(map('session.tool.failed', { id: 'failed-call', error: 'failed', content: [{ type: 'text', text: 'stderr' }] }))
      .toMatchObject({ event: { tool: 'failed-call', status: 'error', error: 'failed', output: 'stderr', complete: true } })
    expect(map('session.tool.failed', {})).toBeNull()

    expect(map('session.step.ended', { finish: 'end_turn', tokens: { input: 2, cache: { read: 1 } } }))
      .toMatchObject({ event: { type: 'step', step: 'finish', reason: 'end_turn', tokens: { input: 2, cache: { read: 1 } } } })
    expect(map('session.step.failed', { error: { name: 'ProviderError' } }))
      .toMatchObject({ event: { type: 'session_error', error: 'ProviderError' } })
    expect(map('session.status', { status: 'idle' })).toMatchObject({ event: { status: 'idle' } })
    expect(map('session.status', { status: {} })).toBeNull()

    expect(map('form.created', { form: { id: 'bad', sessionID: 'session-1', metadata: { kind: 'question' }, fields: [] } })).toBeNull()
    const form = { id: 'form-1', sessionID: 'session-1', title: 'Pick', metadata: { kind: 'question' }, fields: [{ key: 'choice', type: 'string', title: 'Choice' }] }
    expect(map('form.created', { form })).toMatchObject({ event: { type: 'question', action: 'asked', requestId: 'form-1' } })
    expect(map('form.replied', { id: 'form-1', answer: { choice: ['yes', 7] } }))
      .toMatchObject({ event: { action: 'replied', answers: [['yes']] } })
    expect(state.questions.has('form-1')).toBe(false)
    expect(map('form.replied', { id: 'unknown', answer: { first: 'one', second: [false, 'two'] } }))
      .toMatchObject({ event: { action: 'replied', answers: [['one'], ['two']] } })
    expect(map('form.cancelled', { id: 'cancelled' })).toMatchObject({ event: { action: 'rejected', requestId: 'cancelled' } })
  })

  it('maps v2 directories, timestamps, prompt URLs, and UTF-8 attachment sizes', () => {
    expect(() => mapV2Session({ directory: '/missing-id' })).toThrow('without an id')
    expect(mapV2Session({
      id: 'session-1',
      directory: '/fallback/directory',
      time: { created: 0, updated: Number.NaN },
    })).toMatchObject({ directory: '/fallback/directory', createdAt: '1970-01-01T00:00:00.000Z' })
    expect(mapV2Session({ id: 'session-2', location: { directory: '/location' }, directory: '/ignored' }).directory)
      .toBe('/location')

    expect(mapV2PromptParts([
      { type: 'file', content: 'data:text/plain,hello%20%E2%9C%93', filename: 'unicode.txt' },
      { type: 'file', content: 'file:///tmp/input.ts' },
    ])).toEqual({
      text: '',
      files: [
        { uri: 'data:text/plain,hello%20%E2%9C%93', name: 'unicode.txt' },
        { uri: 'file:///tmp/input.ts' },
      ],
    })
    expect(() => mapV2PromptParts([{ type: 'file', content: 'data:text/plain,%E0%A4%A' }]))
      .toThrow('attachments are limited')
    expect(() => mapV2PromptParts([{ type: 'file', content: 'data:missing-comma' }]))
      .toThrow('attachments are limited')
    expect(() => mapV2PromptParts([{ type: 'file', content: '', url: 'not a URL' }]))
      .toThrow('does not support this file URL scheme')
    expect(() => mapV2PromptParts([{ type: 'file', content: '', url: 'https://example.test/file.txt' }]))
      .toThrow('does not support https: file URL scheme')
    expect(mapV2Session({ id: 'session-invalid-date', time: { created: Number.MAX_VALUE } }).createdAt)
      .toBeUndefined()
    expect(mapV2PromptParts([
      { type: 'file', content: 'data:text/plain;base64,YQ==' },
      { type: 'file', content: 'data:text/plain;base64,YWI=' },
      { type: 'file', content: 'data:text/plain;base64,YWJj' },
      { type: 'file', content: 'data:text/plain;base64, YQ==\n' },
    ]).files).toHaveLength(4)
    expect(mapV2PermissionRules([{ permission: 'custom', pattern: '*', action: 'ask' }]))
      .toEqual([{ action: 'custom', resource: '*', effect: 'ask' }])
  })

  it('maps streamed text and reasoning parts with missing metadata and fallback text', () => {
    const state = createV2EventMappingState()
    const map = (type: string, data: Record<string, unknown>) => mapV2Event({
      type,
      data: { sessionID: 'session-1', ...data },
    }, 'session-1', state)

    expect(map('session.text.started', {})).toBeNull()
    expect(map('session.text.started', { assistantMessageID: 'assistant-1' })).toBeNull()
    expect(map('session.text.started', { assistantMessageID: 'assistant-1', ordinal: 2 }))
      .toMatchObject({ event: { type: 'text', partId: 'assistant-1:2', text: '', streaming: true, complete: false } })
    expect(map('session.text.delta', { messageID: 'assistant-1', ordinal: 2, delta: 'hello ' }))
      .toMatchObject({ event: { text: 'hello ', delta: 'hello ', streaming: true } })
    expect(map('session.text.delta', { messageID: 'assistant-1', ordinal: 2, delta: 7 }))
      .toMatchObject({ event: { text: 'hello ', delta: '', streaming: true } })
    expect(map('session.text.ended', { messageID: 'assistant-1', ordinal: 2 }))
      .toMatchObject({ event: { text: 'hello ', streaming: false, complete: true } })
    expect(map('session.text.ended', { messageID: 'assistant-1', ordinal: 2, text: 'final text' }))
      .toMatchObject({ event: { text: 'final text', streaming: false, complete: true } })

    expect(map('session.reasoning.started', { assistantMessageID: 'assistant-1', ordinal: 4 }))
      .toMatchObject({ event: { type: 'reasoning', partId: 'assistant-1:4', text: '', streaming: true } })
    expect(map('session.reasoning.delta', { assistantMessageID: 'assistant-1', ordinal: 4, delta: 'thinking' }))
      .toMatchObject({ event: { text: 'thinking', delta: 'thinking' } })
    expect(map('session.reasoning.delta', { assistantMessageID: 'assistant-1', ordinal: 4, delta: null }))
      .toMatchObject({ event: { text: 'thinking', delta: '' } })
    expect(map('session.reasoning.ended', { assistantMessageID: 'assistant-1', ordinal: 4 }))
      .toMatchObject({ event: { text: 'thinking', streaming: false, complete: true } })
    expect(map('session.reasoning.ended', { assistantMessageID: 'assistant-1', ordinal: 4, text: 'final reasoning' }))
      .toMatchObject({ event: { text: 'final reasoning', streaming: false, complete: true } })
    expect(map('session.reasoning.delta', { assistantMessageID: 'assistant-1' })).toBeNull()
  })

  it('maps execution and step terminal events with complete error fallbacks', () => {
    const map = (type: string, data: Record<string, unknown>) => mapV2Event({
      type,
      data: { sessionID: 'session-1', ...data },
    }, 'session-1')

    expect(map('session.execution.failed', { error: { message: 'execution failed' } }))
      .toMatchObject({ event: { type: 'execution_terminal', outcome: 'failed', error: { message: 'execution failed' } } })
    expect(map('session.execution.interrupted', { reason: 'cancelled' }))
      .toMatchObject({ event: { type: 'execution_terminal', outcome: 'interrupted', error: 'cancelled' } })
    expect(map('session.step.started', { assistantMessageID: 'assistant-1', snapshot: 'start-tree' }))
      .toMatchObject({ event: { type: 'step', step: 'start', messageId: 'assistant-1', snapshot: 'start-tree', complete: false } })
    expect(map('session.step.ended', { finish: 'stop', cost: 0.25, tokens: {
      input: 3,
      output: 5,
      reasoning: 2,
      cache: { read: 1, write: 4 },
    } })).toMatchObject({ event: {
      type: 'step',
      step: 'finish',
      reason: 'stop',
      cost: 0.25,
      tokens: { input: 3, output: 5, reasoning: 2, cache: { read: 1, write: 4 } },
      complete: true,
    } })
    expect(map('session.step.ended', { tokens: { input: 'invalid', cache: { read: null } } }))
      .toMatchObject({ event: { reason: 'unknown', tokens: { cache: {} } } })
    expect(map('session.step.failed', { error: { message: 'request rejected' } }))
      .toMatchObject({ event: { type: 'session_error', error: 'request rejected', details: { message: 'request rejected' } } })
    expect(map('session.step.failed', { error: { name: 'ProviderError' } }))
      .toMatchObject({ event: { error: 'ProviderError' } })
    expect(map('session.step.failed', { error: 'plain error' }))
      .toMatchObject({ event: { error: 'plain error' } })
    expect(map('session.step.failed', { error: 9 }))
      .toMatchObject({ event: { error: 'OpenCode v2 execution failed' } })
  })

  it('maps tool input, running, completed, and failed event edge cases', () => {
    const state = createV2EventMappingState()
    const map = (type: string, data: Record<string, unknown>) => mapV2Event({
      type,
      data: { sessionID: 'session-1', ...data },
    }, 'session-1', state)

    expect(map('session.tool.input.ended', {})).toBeNull()
    expect(map('session.tool.input.ended', { id: 'call-1', text: '42' }))
      .toMatchObject({ event: { status: 'pending', tool: 'call-1', input: { value: 42 }, metadata: undefined } })
    expect(map('session.tool.input.delta', { id: 'call-1', delta: 'garbage' }))
      .toMatchObject({ event: { input: { raw: '42garbage' } } })
    expect(map('session.tool.called', {})).toBeNull()
    expect(map('session.tool.called', { id: 'call-1', input: [] }))
      .toMatchObject({ event: { status: 'running', input: { raw: '42garbage' } } })
    expect(map('session.tool.called', { id: 'explicit-input', input: { command: 'pwd' } }))
      .toMatchObject({ event: { status: 'running', input: { command: 'pwd' } } })
    expect(map('session.tool.progress', {})).toBeNull()
    expect(map('session.tool.progress', { id: 'explicit-input', metadata: { percent: 50 } }))
      .toMatchObject({ event: { status: 'running', input: { command: 'pwd' }, metadata: { percent: 50 } } })

    expect(map('session.tool.success', {})).toBeNull()
    expect(map('session.tool.success', { id: 'explicit-input', content: [
      null,
      { type: 'text', text: 'output' },
      { type: 'file' },
    ] })).toMatchObject({ event: { status: 'completed', output: 'output', attachments: [{}], complete: true } })
    expect(map('session.tool.failed', {})).toBeNull()
    expect(map('session.tool.failed', { id: 'call-1', error: null, content: [
      { type: 'text', text: 'stderr' },
      { type: 'file', name: 'error.log' },
    ] })).toMatchObject({ event: {
      status: 'error',
      error: 'OpenCode v2 execution failed',
      output: 'stderr',
      attachments: [{ filename: 'error.log' }],
      complete: true,
    } })
    expect(state.toolNames.size).toBe(0)
    expect(state.toolInputs.size).toBe(0)
    expect(state.toolInputText.size).toBe(0)
  })

  it('maps status, permission, form cleanup, and cursor-only events', () => {
    const state = createV2EventMappingState()
    const map = (type: string, data: Record<string, unknown>) => mapV2Event({
      type,
      data: { sessionID: 'session-1', ...data },
    }, 'session-1', state)

    expect(map('session.status', { status: 'idle' }))
      .toMatchObject({ event: { type: 'session_status', status: 'idle' } })
    expect(map('session.status.updated', { status: { type: 'retry', attempt: 2, message: 'again', next: 1_000 } }))
      .toMatchObject({ event: { status: 'retry', attempt: 2, message: 'again', next: 1_000 } })
    expect(map('permission.asked', {})).toBeNull()
    expect(map('permission.asked', { id: 'permission-1', action: 'shell', resources: ['src/**', 3], message: 'Run command' }))
      .toMatchObject({ event: {
        type: 'permission',
        action: 'asked',
        permission: 'bash',
        patterns: ['src/**'],
        details: { message: 'Run command' },
      } })
    expect(map('permission.asked', { id: 'permission-2', action: 'custom', resources: [], metadata: { origin: 'test' } }))
      .toMatchObject({ event: { permission: 'custom', details: { origin: 'test' } } })
    expect(map('permission.replied', {})).toBeNull()
    expect(map('permission.replied', { requestID: 'permission-1', reply: 'always' }))
      .toMatchObject({ event: { action: 'replied', permissionId: 'permission-1', details: { reply: 'always' } } })

    const question = {
      id: 'form-cleanup',
      sessionID: 'session-1',
      metadata: { kind: 'question' },
      fields: [{ key: 'choice', type: 'string', title: 'Choice' }],
    }
    expect(map('form.created', { form: question })).toMatchObject({ event: { action: 'asked', requestId: 'form-cleanup' } })
    expect(map('form.replied', { id: 'form-cleanup', answer: null }))
      .toMatchObject({ event: { action: 'replied', answers: undefined } })
    expect(state.questions.has('form-cleanup')).toBe(false)
    expect(state.questionKeys.has('form-cleanup')).toBe(false)
    expect(map('form.cancelled', {})).toBeNull()
    expect(map('form.cancelled', { id: 'unknown-form' }))
      .toMatchObject({ event: { action: 'rejected', requestId: 'unknown-form', tool: undefined } })
    expect(map('session.usage.updated', { cost: 0.5, tokens: { input: 4 } }))
      .toMatchObject({ event: { type: 'debug_event', eventName: 'session.usage.updated', details: { cost: 0.5, tokens: { input: 4 } } } })
    expect(map('session.retry.scheduled', { assistantMessageID: 'assistant-1', attempt: 2, at: 123, error: 'retry' }))
      .toMatchObject({ event: { severity: 'error', messageId: 'assistant-1', details: { attempt: 2, at: 123, error: 'retry' } } })

    expect(mapV2Event({
      type: 'session.created',
      data: { sessionID: 'session-1' },
      durable: { aggregateID: 'session-1', seq: 12 },
    }, 'session-1')).toEqual({ cursor: 12 })
  })
})
