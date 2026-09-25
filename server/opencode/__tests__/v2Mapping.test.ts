import { describe, expect, it } from 'vitest'
import { analyzeAssistantMessages } from '../assistantMessageAnalysis'
import {
  createV2EventMappingState,
  mapV2Event,
  mapV2Message,
  mapV2PermissionRules,
  mapV2PromptParts,
  mapV2Question,
  mapV2QuestionAnswer,
} from '../v2Mapping'

describe('OpenCode v2 wire mappings', () => {
  it('retains assistant content, tool state, errors, usage, and finish details', () => {
    const message = mapV2Message({
      id: 'assistant-1',
      sessionID: 'session-1',
      type: 'assistant',
      agent: 'build',
      model: { providerID: 'acme', id: 'model-1', variant: 'reasoning_high' },
      time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
      content: [
        { type: 'text', text: 'Done.' },
        { type: 'reasoning', text: 'Checked the files.' },
        {
          type: 'tool',
          id: 'call-1',
          name: 'bash',
          state: {
            status: 'completed',
            input: { command: 'pwd' },
            content: [{ type: 'text', text: '/workspace' }],
            time: { created: 10, ran: 11, completed: 14 },
          },
        },
      ],
      finish: 'stop',
      cost: 0.012,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      snapshot: { start: 'before', end: 'after', files: ['src/a.ts'] },
    })

    expect(message).toMatchObject({
      role: 'assistant',
      content: 'Done.',
      info: {
        sender: 'build',
        providerID: 'acme',
        modelID: 'model-1',
        variant: 'reasoning_high',
        finish: 'stop',
        cost: 0.012,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
      parts: [
        { type: 'text', text: 'Done.' },
        { type: 'reasoning', text: 'Checked the files.' },
        { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace' } },
        { type: 'step-finish', reason: 'stop', snapshot: 'after', cost: 0.012 },
      ],
    })
    expect(analyzeAssistantMessages(message ? [message] : []).responseMeta).toMatchObject({
      latestStepFinishReason: 'stop',
      latestStepFinishTokens: { input: 10, output: 5, reasoning: 2 },
    })
  })

  it('preserves the exact structured assistant error for existing diagnostics', () => {
    const error = { name: 'ProviderError', message: 'rate limited', data: { retryAfter: 4 } }
    const message = mapV2Message({ id: 'assistant-2', type: 'assistant', error, content: [] }, 'session-1')
    expect(message?.info?.error).toEqual(error)
  })

  it('maps user text and file metadata without carrying attachment bytes into summaries', () => {
    const message = mapV2Message({
      id: 'user-1',
      type: 'user',
      text: 'Review this image',
      files: [{ name: 'screen.png', mime: 'image/png', source: { type: 'file', path: '/tmp/screen.png' }, data: 'large bytes' }],
    }, 'session-1')
    expect(message).toMatchObject({
      content: 'Review this image',
      parts: [
        { type: 'text', text: 'Review this image' },
        { type: 'file', filename: 'screen.png', mime: 'image/png' },
      ],
    })
    expect(JSON.stringify(message)).not.toContain('large bytes')
  })

  it('maps system parts to instructions and validates file URL schemes and size', () => {
    expect(mapV2PromptParts([
      { type: 'system', content: 'from part' },
      { type: 'text', content: 'first' },
      { type: 'text', content: 'second' },
      { type: 'file', content: '', url: 'file:///tmp/input.ts', filename: 'input.ts' },
    ], 'from option')).toEqual({
      text: 'first\n\nsecond',
      instructions: 'from option\n\nfrom part',
      files: [{ uri: 'file:///tmp/input.ts', name: 'input.ts' }],
    })
    expect(() => mapV2PromptParts([{ type: 'file', content: '', url: 'https://example.test/file' }]))
      .toThrow('does not support https: file URL scheme')
    expect(() => mapV2PromptParts([{ type: 'file', content: '', url: 'data:text/plain;base64,' + 'A'.repeat(28_000_000) }]))
      .toThrow('attachments are limited')
  })

  it('maps permission vocabulary while preserving rule order and effects', () => {
    expect(mapV2PermissionRules([
      { permission: 'bash', pattern: 'git status', action: 'allow' },
      { permission: 'write', pattern: 'src/**', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
    ])).toEqual([
      { action: 'shell', resource: 'git status', effect: 'allow' },
      { action: 'edit', resource: 'src/**', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ])
  })

  it('keeps question option values distinct from labels and maps single and multiple answers', () => {
    const form = {
      id: 'form-1',
      sessionID: 'session-1',
      title: 'Choose',
      metadata: { kind: 'question', tool: { messageID: 'assistant-1', id: 'call-1' } },
      fields: [
        { key: 'environment', type: 'string', title: 'Environment', options: [{ label: 'Production', value: 'prod' }] },
        { key: 'regions', type: 'multiselect', title: 'Regions', options: [{ label: 'North', value: 'north' }, { label: 'South', value: 'south' }] },
      ],
    }
    const question = mapV2Question(form)
    expect(question).toMatchObject({
      id: 'form-1',
      sessionID: 'session-1',
      tool: { messageID: 'assistant-1', callID: 'call-1' },
      questions: [
        { question: 'Environment', header: 'Environment', custom: false, options: [{ label: 'Production', value: 'prod' }] },
        { question: 'Regions', header: 'Regions', custom: false, multiple: true, options: [{ label: 'North', value: 'north' }, { label: 'South', value: 'south' }] },
      ],
    })
    expect(mapV2QuestionAnswer(form, [['prod'], ['north', 'south']]))
      .toEqual({ environment: 'prod', regions: ['north', 'south'] })
    const state = createV2EventMappingState()
    mapV2Event({ type: 'form.created', data: { form } }, 'session-1', state)
    expect(mapV2Event({
      type: 'form.replied',
      data: { id: 'form-1', sessionID: 'session-1', answer: { environment: 'prod', regions: ['north', 'south'] } },
    }, 'session-1', state)?.event).toMatchObject({
      type: 'question',
      action: 'replied',
      requestId: 'form-1',
      answers: [['prod'], ['north', 'south']],
      tool: { messageID: 'assistant-1', callID: 'call-1' },
    })
    expect(mapV2Question({ ...form, metadata: { kind: 'approval' } })).toBeNull()
  })

  it('maps the question body from description and uses each field title as its header', () => {
    expect(mapV2Question({
      id: 'form-2',
      sessionID: 'session-1',
      title: 'Questions',
      metadata: { kind: 'question' },
      fields: [
        { key: 'task', type: 'string', title: 'Task', description: 'What should change?' },
        { key: 'mode', type: 'string', title: 'Mode' },
        { key: 'fallback', type: 'string', description: 'Fallback prompt' },
      ],
    })?.questions).toEqual([
      { question: 'What should change?', header: 'Task', options: [], custom: false },
      { question: 'Mode', header: 'Mode', options: [], custom: false },
      { question: 'Fallback prompt', header: 'Questions', options: [], custom: false },
    ])
  })

  it('maps durable lifecycle and tool events with their cursors and ignores other sessions', () => {
    const state = createV2EventMappingState()
    expect(mapV2Event({
      type: 'session.inbox.enqueued',
      data: { sessionID: 'session-1', inboxID: 'inbox-1', item: {} },
      durable: { aggregateID: 'session-1', seq: 8 },
    }, 'session-1', state)).toEqual({
      cursor: 8,
      event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-1' },
    })
    expect(mapV2Event({
      type: 'session.execution.succeeded',
      data: { sessionID: 'other-session' },
      durable: { aggregateID: 'other-session', seq: 9 },
    }, 'session-1', state)).toBeNull()
    expect(mapV2Event({
      type: 'form.created',
      data: { form: { id: 'form-1', sessionID: 'session-1', title: 'Choose', metadata: { kind: 'question' }, fields: [{ key: 'q0', type: 'string' }] } },
    }, 'session-1', state)?.event).toMatchObject({ type: 'question', action: 'asked', requestId: 'form-1' })
    expect(mapV2Event({
      type: 'session.tool.input.started',
      data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', id: 'call-1', name: 'bash' },
    }, 'session-1', state)?.event).toMatchObject({ type: 'tool', status: 'pending', callId: 'call-1', tool: 'bash' })
    expect(mapV2Event({
      type: 'session.tool.input.delta',
      data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', id: 'call-1', delta: '{"command":"git' },
    }, 'session-1', state)?.event).toMatchObject({ type: 'tool', status: 'pending', input: { raw: '{"command":"git' } })
    expect(mapV2Event({
      type: 'permission.asked',
      data: { sessionID: 'session-1', id: 'permission-1', action: 'shell', resources: ['git status'] },
    }, 'session-1', state)?.event).toMatchObject({ type: 'permission', action: 'asked', permission: 'bash' })
  })

  it('maps inbox cancellation and delivery changes as lifecycle events', () => {
    expect(mapV2Event({
      type: 'session.inbox.cancelled',
      data: { sessionID: 'session-1', inboxID: 'inbox-1' },
      durable: { aggregateID: 'session-1', seq: 10 },
    }, 'session-1')).toEqual({
      cursor: 10,
      event: { type: 'inbox_cancelled', sessionId: 'session-1', inboxID: 'inbox-1' },
    })
    expect(mapV2Event({
      type: 'session.inbox.delivery.changed',
      data: { sessionID: 'session-1', inboxID: 'inbox-1', delivery: 'queue' },
      durable: { aggregateID: 'session-1', seq: 11 },
    }, 'session-1')).toEqual({
      cursor: 11,
      event: { type: 'inbox_delivery_changed', sessionId: 'session-1', inboxID: 'inbox-1', delivery: 'queue' },
    })
  })

  it('accounts for the pinned durable no-op manifest and leaves unknown durable events unmapped', () => {
    for (const type of [
      'session.moved',
      'session.message.content.updated',
      'session.compaction.started',
      'session.revert.staged',
      'session.usage.recorded',
    ]) {
      expect(mapV2Event({
        type,
        data: { sessionID: 'session-1' },
        durable: { aggregateID: 'session-1', seq: 12 },
      }, 'session-1')).toEqual({ cursor: 12 })
    }
    expect(mapV2Event({
      type: 'session.future.unknown',
      data: { sessionID: 'session-1' },
      durable: { aggregateID: 'session-1', seq: 13 },
    }, 'session-1')).toBeNull()
  })
})
