import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../sse/broadcaster', () => ({
  broadcaster: {
    broadcast: vi.fn(),
  },
}))

import * as ticketsModule from '../../storage/tickets'
import * as atomicAppendModule from '../../io/atomicAppend'
import { broadcaster } from '../../sse/broadcaster'

vi.spyOn(ticketsModule, 'getTicketPaths').mockReturnValue({
  projectRoot: '/tmp/test-project',
  executionLogPath: '/tmp/test-execution-log.jsonl',
  debugLogPath: '/tmp/test-execution-log.debug.jsonl',
  aiLogPath: '/tmp/test-execution-log.ai.jsonl',
  worktreePath: '/tmp/test-worktree',
  ticketDir: '/tmp/test-ticket-dir',
  executionSetupDir: '/tmp/test-ticket-dir/.ticket/runtime/execution-setup',
  executionSetupProfilePath: '/tmp/test-ticket-dir/.ticket/runtime/execution-setup-profile.json',
  baseBranch: 'main',
  beadsPath: '/tmp/test-beads.jsonl',
})

const mockAppend = vi.spyOn(atomicAppendModule, 'safeAtomicAppend').mockImplementation((_path, line) => ({
  offset: 0,
  length: Buffer.byteLength(`${line}\n`),
}))
const mockBroadcast = vi.mocked(broadcaster.broadcast)

import {
  createOpenCodeStreamState,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
} from '../phases/helpers'

function getPersistedEntries() {
  return mockAppend.mock.calls.map(([, payload]) => JSON.parse(payload))
}

function getNormalPersistedEntries() {
  return mockAppend.mock.calls
    .filter(([logPath]) => logPath === '/tmp/test-execution-log.jsonl')
    .map(([, payload]) => JSON.parse(payload))
}

function getAiPersistedEntries() {
  return mockAppend.mock.calls
    .filter(([logPath]) => logPath === '/tmp/test-execution-log.ai.jsonl')
    .map(([, payload]) => JSON.parse(payload))
}

function getPersistedTextEntries() {
  return getNormalPersistedEntries().filter((entry) => entry.kind === 'text')
}

describe('OpenCode log canonicalization', () => {
  beforeEach(() => {
    mockAppend.mockClear()
    mockBroadcast.mockClear()
  })

  it('persists a single canonical text row for a single text-part assistant response', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-1', {
      type: 'text',
      sessionId: 'ses-1',
      messageId: 'msg-1',
      partId: 'part-1',
      text: 'questions:\n  - id: Q01',
      streaming: true,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-1', {
      type: 'done',
      sessionId: 'ses-1',
    }, state)

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'COUNCIL_DELIBERATING',
      'openai/gpt-5-mini',
      'ses-1',
      'draft',
      'questions:\n  - id: Q01',
      [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'questions:\n  - id: Q01',
        },
      ],
      state,
    )

    const textEntries = getPersistedTextEntries()
    expect(textEntries).toEqual([
      expect.objectContaining({
        entryId: 'ses-1:msg-1:text',
        content: 'questions:\n  - id: Q01',
        kind: 'text',
        op: 'finalize',
      }),
    ])
    expect(getPersistedEntries().some((entry) => entry.entryId === 'ses-1:transcript-summary')).toBe(false)
  })

  it('persists structured model attribution on OpenCode summary rows across stages', () => {
    const memberId = 'openai/gpt-5-mini'
    const stages = ['draft', 'vote', 'coverage', 'refine'] as const

    for (const stage of stages) {
      emitOpenCodeSessionLogs(
        '1:T-42',
        'T-42',
        'COUNCIL_DELIBERATING',
        memberId,
        `ses-${stage}`,
        stage,
        `${stage} response`,
        [
          {
            id: `msg-${stage}`,
            role: 'assistant',
            content: `${stage} response`,
          },
        ],
        createOpenCodeStreamState(),
      )
    }

    const summaryEntries = getPersistedEntries().filter((entry) =>
      typeof entry.message === 'string' && entry.message.startsWith('OpenCode '),
    )

    expect(summaryEntries).toEqual(expect.arrayContaining(
      stages.map((stage) => expect.objectContaining({
        message: `OpenCode ${stage}: ${memberId} session=ses-${stage}, messages=1, responseChars=${`${stage} response`.length}.`,
        source: 'system',
        modelId: memberId,
      })),
    ))
  })

  it('combines multiple text parts for the same assistant message into one persisted row', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-2', {
      type: 'text',
      sessionId: 'ses-2',
      messageId: 'msg-2',
      partId: 'part-a',
      text: 'prd:\n',
      streaming: true,
      complete: false,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-2', {
      type: 'text',
      sessionId: 'ses-2',
      messageId: 'msg-2',
      partId: 'part-b',
      text: '  title: Canonical PRD',
      streaming: true,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-2', {
      type: 'done',
      sessionId: 'ses-2',
    }, state)

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'DRAFTING_PRD',
      'openai/gpt-5-codex',
      'ses-2',
      'draft',
      'prd:\n  title: Canonical PRD',
      [
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'prd:\n  title: Canonical PRD',
        },
      ],
      state,
    )

    const textEntries = getPersistedTextEntries()
    expect(textEntries).toHaveLength(1)
    expect(textEntries[0]).toMatchObject({
      entryId: 'ses-2:msg-2:text',
      content: 'prd:\n  title: Canonical PRD',
      op: 'finalize',
    })
  })

  it('classifies streamed tool-loop narration as assistant activity and only the terminal message as output', () => {
    const state = createOpenCodeStreamState()
    const base = ['1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-loop'] as const

    emitOpenCodeStreamEvent(...base, {
      type: 'text',
      sessionId: 'ses-loop',
      messageId: 'msg-progress',
      partId: 'part-progress',
      text: 'Tests passed. Checking lint next.',
      streaming: false,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent(...base, {
      type: 'tool',
      sessionId: 'ses-loop',
      messageId: 'msg-progress',
      partId: 'part-tool',
      tool: 'bash',
      callId: 'call-tool',
      status: 'completed',
      output: 'lint passed',
      complete: true,
    }, state)
    emitOpenCodeStreamEvent(...base, {
      type: 'text',
      sessionId: 'ses-loop',
      messageId: 'msg-final',
      partId: 'part-final',
      text: '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
      streaming: false,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent(...base, { type: 'done', sessionId: 'ses-loop' }, state)

    emitOpenCodeSessionLogs(
      ...base,
      'coding_main',
      '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
      [
        { id: 'user-loop', role: 'user', content: 'Implement the bead.' },
        {
          id: 'msg-progress',
          role: 'assistant',
          content: 'Tests passed. Checking lint next.',
          parts: [{
            id: 'part-progress',
            sessionID: 'ses-loop',
            messageID: 'msg-progress',
            type: 'text',
            text: 'Tests passed. Checking lint next.',
          }],
        },
        {
          id: 'msg-final',
          role: 'assistant',
          content: '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
          parts: [{
            id: 'part-final',
            sessionID: 'ses-loop',
            messageID: 'msg-final',
            type: 'text',
            text: '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
          }],
        },
      ],
      state,
    )

    const assistantEntries = getNormalPersistedEntries()
      .filter((entry) => entry.entryId === 'ses-loop:msg-progress:text')
    const finalEntries = getNormalPersistedEntries()
      .filter((entry) => entry.entryId === 'ses-loop:msg-final:text')
    expect(assistantEntries).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        content: '[ASSISTANT] Tests passed. Checking lint next.',
        op: 'finalize',
      }),
    ])
    expect(finalEntries).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
        op: 'finalize',
      }),
    ])
  })

  it('broadcasts progressive text upserts on the 10ms live cadence while only persisting the final row', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const state = createOpenCodeStreamState()

    try {
      emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-throttle', {
        type: 'text',
        sessionId: 'ses-throttle',
        messageId: 'msg-throttle',
        partId: 'part-throttle',
        text: 'a',
        streaming: true,
        complete: false,
      }, state)

      emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-throttle', {
        type: 'text',
        sessionId: 'ses-throttle',
        messageId: 'msg-throttle',
        partId: 'part-throttle',
        text: 'ab',
        streaming: true,
        complete: false,
      }, state)

      nowSpy.mockReturnValue(1010)
      emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-throttle', {
        type: 'text',
        sessionId: 'ses-throttle',
        messageId: 'msg-throttle',
        partId: 'part-throttle',
        text: 'abc',
        streaming: true,
        complete: false,
      }, state)

      emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'openai/gpt-5-codex', 'ses-throttle', {
        type: 'done',
        sessionId: 'ses-throttle',
      }, state)

      const textBroadcasts = mockBroadcast.mock.calls
        .map(([, , payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.kind === 'text')

      expect(textBroadcasts.map((payload) => ({
        content: payload.content,
        op: payload.op,
        streaming: payload.streaming,
        phaseAttempt: payload.phaseAttempt,
      }))).toEqual([
        { content: 'a', op: 'upsert', streaming: true, phaseAttempt: 1 },
        { content: 'abc', op: 'upsert', streaming: true, phaseAttempt: 1 },
        { content: 'abc', op: 'finalize', streaming: false, phaseAttempt: 1 },
      ])
      expect(getPersistedTextEntries()).toEqual([
        expect.objectContaining({
          entryId: 'ses-throttle:msg-throttle:text',
          content: 'abc',
          op: 'finalize',
        }),
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('truncates oversized live debug broadcasts while keeping the persisted debug entry complete', () => {
    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'DRAFTING_PRD',
      'openai/gpt-5-codex',
      'ses-debug',
      'draft',
      'x'.repeat(10_000),
      [
        {
          id: 'msg-debug',
          role: 'assistant',
          content: 'x'.repeat(10_000),
        },
      ],
      createOpenCodeStreamState(),
    )

    const debugBroadcast = mockBroadcast.mock.calls
      .map(([, , payload]) => payload as Record<string, unknown>)
      .find((payload) => payload.type === 'debug' && String(payload.content).includes('opencode.draft.response'))
    expect(String(debugBroadcast?.content)).toContain('debug payload truncated for live stream')
    expect(String(debugBroadcast?.content).length).toBeLessThan(9000)
    expect(debugBroadcast?.phaseAttempt).toBe(1)

    const persistedDebug = getPersistedEntries()
      .find((entry) => entry.type === 'debug' && String(entry.content).includes('opencode.draft.response'))
    expect(String(persistedDebug?.content).length).toBeGreaterThan(10_000)
  })

  it('falls back to one raw output row when no streamed text was observed', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'SCANNING_RELEVANT_FILES',
      'openai/gpt-5-mini',
      'ses-3',
      'relevant_files_scan',
      'files:\n  - src/app.ts',
      [
        {
          id: 'msg-3',
          role: 'assistant',
          content: 'files:\n  - src/app.ts',
        },
      ],
      state,
    )

    const textEntries = getPersistedTextEntries()
    expect(textEntries).toEqual([
      expect.objectContaining({
        entryId: 'ses-3:msg-3:text',
        content: 'files:\n  - src/app.ts',
        kind: 'text',
        op: 'finalize',
      }),
    ])
    expect(getPersistedEntries().some((entry) => entry.entryId === 'ses-3:transcript-summary')).toBe(false)
  })

  it('backfills reasoning, tool, and step AI detail rows from completed session messages', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'SCANNING_RELEVANT_FILES',
      'openai/gpt-5.3-codex',
      'ses-snapshot',
      'relevant_files_scan',
      '<RESULT>done</RESULT>',
      [
        {
          id: 'msg-snapshot',
          role: 'assistant',
          content: '<RESULT>done</RESULT>',
          parts: [
            {
              id: 'step-start-1',
              sessionID: 'ses-snapshot',
              messageID: 'msg-snapshot',
              type: 'step-start',
            },
            {
              id: 'reasoning-1',
              sessionID: 'ses-snapshot',
              messageID: 'msg-snapshot',
              type: 'reasoning',
              text: 'thinking through relevant files',
            },
            {
              id: 'tool-1',
              sessionID: 'ses-snapshot',
              messageID: 'msg-snapshot',
              type: 'tool',
              callID: 'call-1',
              tool: 'bash',
              state: {
                status: 'completed',
                title: 'List source',
                input: { command: 'rg --files src' },
                output: 'src/App.tsx',
              },
            },
            {
              id: 'text-1',
              sessionID: 'ses-snapshot',
              messageID: 'msg-snapshot',
              type: 'text',
              text: '<RESULT>done</RESULT>',
            },
            {
              id: 'step-finish-1',
              sessionID: 'ses-snapshot',
              messageID: 'msg-snapshot',
              type: 'step-finish',
              reason: 'stop',
            },
          ],
        },
      ],
      state,
    )

    const aiEntries = getAiPersistedEntries()
    expect(aiEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-snapshot:step-start-1',
        kind: 'step',
        op: 'append',
        content: 'Step started.',
      }),
      expect.objectContaining({
        entryId: 'ses-snapshot:reasoning-1',
        kind: 'reasoning',
        op: 'finalize',
        content: 'thinking through relevant files',
      }),
      expect.objectContaining({
        entryId: 'ses-snapshot:tool-1',
        kind: 'tool',
        op: 'finalize',
        content: expect.stringContaining('[TOOL] bash completed: List source'),
      }),
      expect.objectContaining({
        entryId: 'ses-snapshot:step-finish-1',
        kind: 'step',
        op: 'finalize',
        content: 'Step finished: stop',
      }),
    ]))
    expect(aiEntries.find((entry) => entry.entryId === 'ses-snapshot:tool-1')?.content).toContain('"command": "rg --files src"')
    expect(aiEntries.find((entry) => entry.entryId === 'ses-snapshot:tool-1')?.content).toContain('Output:\nsrc/App.tsx')
  })

  it('backfills AI detail rows from every assistant message in a tool-use session snapshot', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'SCANNING_RELEVANT_FILES',
      'openai/gpt-5.3-codex',
      'ses-tools',
      'relevant_files_scan',
      '<RELEVANT_FILES_RESULT>done</RELEVANT_FILES_RESULT>',
      [
        {
          id: 'msg-previous-user',
          role: 'user',
          content: 'Previous prompt',
        },
        {
          id: 'msg-previous-assistant',
          role: 'assistant',
          content: 'Old progress narration.',
          parts: [
            {
              id: 'previous-text',
              sessionID: 'ses-tools',
              messageID: 'msg-previous-assistant',
              type: 'text',
              text: 'Old progress narration.',
            },
            {
              id: 'previous-tool-call',
              sessionID: 'ses-tools',
              messageID: 'msg-previous-assistant',
              type: 'tool',
              callID: 'call-previous-tool',
              tool: 'bash',
              state: {
                status: 'completed',
                title: 'Previous command',
                input: { command: 'echo previous' },
                output: 'previous',
              },
            },
          ],
        },
        {
          id: 'msg-current-user',
          role: 'user',
          content: 'Current prompt',
        },
        {
          id: 'msg-tool-turn',
          role: 'assistant',
          content: 'I will inspect the theme variables before answering.',
          parts: [
            {
              id: 'tool-turn-text',
              sessionID: 'ses-tools',
              messageID: 'msg-tool-turn',
              type: 'text',
              text: 'I will inspect the theme variables before answering.',
            },
            {
              id: 'tool-turn-step-start',
              sessionID: 'ses-tools',
              messageID: 'msg-tool-turn',
              type: 'step-start',
            },
            {
              id: 'tool-turn-reasoning',
              sessionID: 'ses-tools',
              messageID: 'msg-tool-turn',
              type: 'reasoning',
              text: 'I need to inspect theme files before answering.',
            },
            {
              id: 'tool-turn-call',
              sessionID: 'ses-tools',
              messageID: 'msg-tool-turn',
              type: 'tool',
              callID: 'call-tool-turn',
              tool: 'read',
              state: {
                status: 'completed',
                title: 'Read theme variables',
                input: { filePath: 'ui/src/scss/_vars.scss' },
                output: '$primaryColor: #e91e63;',
              },
            },
            {
              id: 'tool-turn-step-finish',
              sessionID: 'ses-tools',
              messageID: 'msg-tool-turn',
              type: 'step-finish',
              reason: 'tool',
            },
          ],
        },
        {
          id: 'msg-final-turn',
          role: 'assistant',
          content: '<RELEVANT_FILES_RESULT>done</RELEVANT_FILES_RESULT>',
          info: {
            id: 'msg-final-turn',
            sessionID: 'ses-tools',
            role: 'assistant',
            variant: 'xhigh',
          },
          parts: [
            {
              id: 'final-text',
              sessionID: 'ses-tools',
              messageID: 'msg-final-turn',
              type: 'text',
              text: '<RELEVANT_FILES_RESULT>done</RELEVANT_FILES_RESULT>',
            },
          ],
        },
      ],
      state,
    )

    const aiEntries = getAiPersistedEntries()
    expect(aiEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-tools:msg-tool-turn:text',
        kind: 'assistant',
        content: '[ASSISTANT] I will inspect the theme variables before answering.',
      }),
      expect.objectContaining({
        entryId: 'ses-tools:tool-turn-reasoning',
        kind: 'reasoning',
        content: 'I need to inspect theme files before answering.',
      }),
      expect.objectContaining({
        entryId: 'ses-tools:tool-turn-call',
        kind: 'tool',
        content: expect.stringContaining('[TOOL] read completed: Read theme variables'),
      }),
      expect.objectContaining({
        entryId: 'ses-tools:msg-final-turn:text',
        kind: 'text',
        content: '<RELEVANT_FILES_RESULT>done</RELEVANT_FILES_RESULT>',
        variant: 'xhigh',
      }),
    ]))
    expect(aiEntries.find((entry) => entry.entryId === 'ses-tools:tool-turn-call')?.content)
      .toContain('ui/src/scss/_vars.scss')
    expect(aiEntries.some((entry) => entry.entryId === 'ses-tools:previous-tool-call')).toBe(false)
    expect(aiEntries.some((entry) => entry.entryId === 'ses-tools:msg-previous-assistant:text')).toBe(false)
  })

  it('does not duplicate AI part rows already finalized from the live stream', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-live', {
      type: 'tool',
      sessionId: 'ses-live',
      messageId: 'msg-live',
      partId: 'part-tool',
      tool: 'bash',
      callId: 'call-live',
      status: 'completed',
      title: 'Run tests',
      input: { command: 'npm test' },
      output: 'pass',
      complete: true,
    }, state, 'bead-1')

    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'CODING',
      'openai/gpt-5.4',
      'ses-live',
      'coding_main',
      '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
      [
        {
          id: 'msg-live',
          role: 'assistant',
          content: '<BEAD_STATUS>{"status":"done"}</BEAD_STATUS>',
          parts: [
            {
              id: 'part-tool',
              sessionID: 'ses-live',
              messageID: 'msg-live',
              type: 'tool',
              callID: 'call-live',
              tool: 'bash',
              state: {
                status: 'completed',
                title: 'Run tests',
                input: { command: 'npm test' },
                output: 'pass',
              },
            },
          ],
        },
      ],
      state,
      'bead-1',
    )

    const aiToolEntries = getAiPersistedEntries().filter((entry) => entry.entryId === 'ses-live:part-tool')
    expect(aiToolEntries).toHaveLength(1)
  })

  it('retains beadId on finalized streamed text rows', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-bead', {
      type: 'text',
      sessionId: 'ses-bead',
      messageId: 'msg-bead',
      partId: 'part-bead',
      text: '<BEAD_STATUS>{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}</BEAD_STATUS>',
      streaming: true,
      complete: true,
    }, state, 'bead-1', 2)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-bead', {
      type: 'done',
      sessionId: 'ses-bead',
    }, state, 'bead-1', 2)

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-bead:msg-bead:text',
        beadId: 'bead-1',
        beadIteration: 2,
        kind: 'text',
        op: 'finalize',
      }),
    ]))
  })

  it('retains beadId on fallback session-history rows', () => {
    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'CODING',
      'openai/gpt-5.4',
      'ses-fallback',
      'coding_main',
      '<BEAD_STATUS>{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}</BEAD_STATUS>',
      [
        {
          id: 'msg-fallback',
          role: 'assistant',
          content: '<BEAD_STATUS>{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}</BEAD_STATUS>',
        },
      ],
      createOpenCodeStreamState(),
      'bead-1',
      3,
    )

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-fallback:msg-fallback:text',
        beadId: 'bead-1',
        beadIteration: 3,
        kind: 'text',
        op: 'finalize',
      }),
    ]))
  })

  it('persists step-start rows without marking them as streaming', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-step', {
      type: 'step',
      sessionId: 'ses-step',
      partId: 'part-step-1',
      step: 'start',
      complete: false,
    }, state)

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-step:part-step-1',
        kind: 'step',
        op: 'append',
        streaming: false,
        content: 'Step started.',
      }),
    ]))
  })

  it('persists model attribution on session retry error rows', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'opencode/minimax-m2.5-free', 'ses-retry', {
      type: 'session_status',
      sessionId: 'ses-retry',
      status: 'retry',
      attempt: 1,
      message: '<none>',
    }, state)

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-retry:retry:1',
        content: 'Session retry #1: <none>',
        kind: 'error',
        source: 'model:opencode/minimax-m2.5-free',
        modelId: 'opencode/minimax-m2.5-free',
        sessionId: 'ses-retry',
      }),
    ]))
  })

  it('persists structured provider details on session error rows without storing raw request bodies', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'DRAFTING_PRD', 'kilo/nvidia/nemotron-3-super-120b-a12b:free', 'ses-error', {
      type: 'session_error',
      sessionId: 'ses-error',
      error: 'Provider returned error',
      details: {
        error: {
          name: 'AI_APICallError',
          statusCode: 402,
          url: 'https://api.kilo.ai/api/gateway/chat/completions',
          requestBodyValues: {
            model: 'anthropic/claude-haiku-4.5',
            messages: [{ role: 'system', content: 'very large prompt body' }],
          },
          responseBody: JSON.stringify({
            error: {
              title: 'Low Credit Warning!',
              message: 'Add credits to continue, or switch to a free model',
            },
          }),
          data: {
            error: {
              type: 'ModelError',
              message: 'Add credits to continue, or switch to a free model',
            },
          },
        },
      },
    }, state)

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-error:error',
        content: 'Low Credit Warning!: Add credits to continue, or switch to a free model (HTTP 402, requestModel=anthropic/claude-haiku-4.5)',
        kind: 'error',
        source: 'model:kilo/nvidia/nemotron-3-super-120b-a12b:free',
        modelId: 'kilo/nvidia/nemotron-3-super-120b-a12b:free',
        sessionId: 'ses-error',
        data: expect.objectContaining({
          errorDetails: expect.objectContaining({
            name: 'AI_APICallError',
            statusCode: 402,
            requestModel: 'anthropic/claude-haiku-4.5',
            responseErrorType: 'ModelError',
            responseErrorTitle: 'Low Credit Warning!',
            responseErrorMessage: 'Add credits to continue, or switch to a free model',
          }),
        }),
      }),
    ]))

    const errorEntry = getPersistedEntries().find((entry) => entry.entryId === 'ses-error:error')
    expect(errorEntry?.data?.errorDetails).not.toHaveProperty('requestBodyValues')
  })

  it('does not label the last progress narration as final output when the session fails', () => {
    const state = createOpenCodeStreamState()
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-failed-progress', {
      type: 'text',
      sessionId: 'ses-failed-progress',
      messageId: 'msg-progress',
      partId: 'part-progress',
      text: 'Tests passed. Starting the build.',
      streaming: false,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-failed-progress', {
      type: 'session_error',
      sessionId: 'ses-failed-progress',
      error: 'Provider disconnected',
    }, state)

    expect(getNormalPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-failed-progress:msg-progress:text',
        kind: 'assistant',
        content: '[ASSISTANT] Tests passed. Starting the build.',
      }),
      expect.objectContaining({
        entryId: 'ses-failed-progress:error',
        kind: 'error',
      }),
    ]))
  })

  it('persists generated OpenCode APIError details from readiness probe session errors', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'PRE_FLIGHT_CHECK', 'openai/gpt-5.3-codex', 'ses-probe', {
      type: 'session_error',
      sessionId: 'ses-probe',
      error: 'Provider request failed',
      details: {
        name: 'APIError',
        data: {
          message: 'Your authentication token has been invalidated. Please try signing in again.',
          statusCode: 401,
          isRetryable: false,
          responseBody: JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'token_invalidated',
              message: 'Your authentication token has been invalidated. Please try signing in again.',
            },
          }),
        },
      },
    }, state)

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        entryId: 'ses-probe:error',
        content: 'invalid_request_error: Your authentication token has been invalidated. Please try signing in again. (HTTP 401)',
        audience: 'ai',
        kind: 'error',
        source: 'model:openai/gpt-5.3-codex',
        modelId: 'openai/gpt-5.3-codex',
        sessionId: 'ses-probe',
        data: expect.objectContaining({
          errorDetails: expect.objectContaining({
            name: 'APIError',
            statusCode: 401,
            responseErrorType: 'invalid_request_error',
            responseErrorMessage: 'Your authentication token has been invalidated. Please try signing in again.',
          }),
        }),
      }),
    ]))
  })

  it('emits one canonical text row per assistant response when a session is reused', () => {
    const state = createOpenCodeStreamState()

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-4', {
      type: 'text',
      sessionId: 'ses-4',
      messageId: 'msg-4a',
      partId: 'part-4a',
      text: 'first response',
      streaming: true,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-4', {
      type: 'done',
      sessionId: 'ses-4',
    }, state)
    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'COUNCIL_DELIBERATING',
      'openai/gpt-5-mini',
      'ses-4',
      'draft',
      'first response',
      [
        {
          id: 'msg-4a',
          role: 'assistant',
          content: 'first response',
        },
      ],
      state,
    )

    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-4', {
      type: 'text',
      sessionId: 'ses-4',
      messageId: 'msg-4b',
      partId: 'part-4b',
      text: 'second response',
      streaming: true,
      complete: true,
    }, state)
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'COUNCIL_DELIBERATING', 'openai/gpt-5-mini', 'ses-4', {
      type: 'done',
      sessionId: 'ses-4',
    }, state)
    emitOpenCodeSessionLogs(
      '1:T-42',
      'T-42',
      'COUNCIL_DELIBERATING',
      'openai/gpt-5-mini',
      'ses-4',
      'draft',
      'second response',
      [
        {
          id: 'msg-4a',
          role: 'assistant',
          content: 'first response',
        },
        {
          id: 'user-4',
          role: 'user',
          content: 'Please continue.',
        },
        {
          id: 'msg-4b',
          role: 'assistant',
          content: 'second response',
        },
      ],
      state,
    )

    const textEntries = getPersistedTextEntries()
    expect(textEntries).toHaveLength(2)
    expect(textEntries.map((entry) => entry.entryId)).toEqual([
      'ses-4:msg-4a:text',
      'ses-4:msg-4b:text',
    ])
    expect(textEntries.map((entry) => entry.content)).toEqual([
      'first response',
      'second response',
    ])
    expect(getPersistedEntries().some((entry) => String(entry.entryId).includes('transcript-summary'))).toBe(false)
  })

  it('persists OpenCode tool input, output, and error details as model-attributed AI rows', () => {
    emitOpenCodeStreamEvent('1:T-42', 'T-42', 'CODING', 'openai/gpt-5.4', 'ses-tool', {
      type: 'tool',
      sessionId: 'ses-tool',
      messageId: 'msg-tool',
      partId: 'part-tool',
      tool: 'bash',
      callId: 'call-1',
      status: 'error',
      title: 'Run tests',
      input: {
        command: 'npm test -- --runInBand',
        cwd: '/tmp/worktree',
      },
      output: 'stdout line',
      error: 'stderr line',
      durationMs: 1250,
      compactedAt: Date.UTC(2026, 6, 23, 10, 0, 0),
      attachments: [
        { filename: 'results.json', mime: 'application/json' },
        { mime: 'text/plain' },
      ],
      complete: true,
    }, createOpenCodeStreamState(), 'bead-1')

    expect(getPersistedEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'ses-tool:part-tool',
        source: 'model:openai/gpt-5.4',
        modelId: 'openai/gpt-5.4',
        beadId: 'bead-1',
        kind: 'tool',
        content: expect.stringContaining('[TOOL] bash error (1.25s): Run tests'),
      }),
    ]))

    const toolEntry = getPersistedEntries().find((entry) => entry.entryId === 'ses-tool:part-tool')
    expect(toolEntry?.content).toContain('Input:')
    expect(toolEntry?.content).toContain('"command": "npm test -- --runInBand"')
    expect(toolEntry?.content).toContain('Output:\nstdout line')
    expect(toolEntry?.content).toContain('Error:\nstderr line')
    expect(toolEntry?.content).toContain('Attachments: 2')
    expect(toolEntry?.content).toContain('- results.json (application/json)')
    expect(toolEntry?.content).toContain('Compacted: 2026-07-23T10:00:00.000Z')
  })
})
