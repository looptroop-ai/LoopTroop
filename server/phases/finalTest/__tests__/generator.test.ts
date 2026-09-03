import { afterAll, describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../../../opencode/permissions'
import { SILENT_DEFAULT_PERMISSIONS } from '../../../opencode/toolPolicy'
import { patchTicket } from '../../../storage/tickets'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { generateFinalTests } from '../generator'
import type { OpenCodePromptDispatchEvent } from '../../../workflow/runOpenCodePrompt'
import { detectHostContext } from '../../../lib/hostContext'
import { normalizeCommandSpec } from '@shared/commandSpec'

const LEGACY_TEST_COMMAND = normalizeCommandSpec('npm run test:server', detectHostContext())

class SequencedMockOpenCodeAdapter extends MockOpenCodeAdapter {
  private promptCounts = new Map<string, number>()

  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>) {
    const sessionId = args[0]
    const nextCount = (this.promptCounts.get(sessionId) ?? 0) + 1
    this.promptCounts.set(sessionId, nextCount)

    const queuedResponse = this.mockResponses.get(`${sessionId}#${nextCount}`)
    if (queuedResponse !== undefined) {
      this.mockResponses.set(sessionId, queuedResponse)
    }
    const queuedStreamEvents = this.mockStreamEvents.get(`${sessionId}#${nextCount}`)
    if (queuedStreamEvents !== undefined) {
      this.mockStreamEvents.set(sessionId, queuedStreamEvents)
    }
    const queuedAssistantInfo = this.mockAssistantInfos.get(`${sessionId}#${nextCount}`)
    if (queuedAssistantInfo !== undefined) {
      this.mockAssistantInfos.set(sessionId, queuedAssistantInfo)
    }

    return await super.promptSession(...args)
  }
}

class HangingPromptAdapter extends MockOpenCodeAdapter {
  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>): Promise<string> {
    const [sessionId, parts, signal, options] = args
    this.promptCalls.push({ sessionId, parts, options })

    return await new Promise<string>((_, reject) => {
      const timeoutError = new Error('Timeout')
      if (signal?.aborted) {
        reject(timeoutError)
        return
      }
      signal?.addEventListener('abort', () => reject(timeoutError), { once: true })
    })
  }
}

const repoManager = createTestRepoManager('final-test-generator-')

describe('generateFinalTests', () => {
  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('retries malformed final test markers in the same session', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'I added tests to cover the whole ticket.')
    adapter.mockResponses.set('mock-session-1#2', [
      '<FINAL_TEST_COMMANDS>',
      '```yaml',
      'command_plan:',
      '  commands: npm run test:server',
      '  summary: verify end-to-end ticket coverage',
      '```',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    const result = await generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      '/tmp/test',
    )

    expect(result.commandPlan).toEqual({
      markerFound: true,
      commands: [LEGACY_TEST_COMMAND.command],
      summary: 'verify end-to-end ticket coverage',
      testFiles: [],
      modifiedFiles: [],
      fileEffects: [],
      testsCount: null,
      errors: [],
      repairApplied: true,
      repairWarnings: [
        'Unwrapped markdown code fence wrapping the YAML payload.',
        'Removed wrapper key "command_plan" from top level.',
        'Coerced commands from string to array',
        LEGACY_TEST_COMMAND.warning,
      ],
    })
    expect(result.output).toContain('<FINAL_TEST_COMMANDS>')
    expect(result.structuredOutput).toMatchObject({
      repairApplied: true,
      repairWarnings: [
        'Unwrapped markdown code fence wrapping the YAML payload.',
        'Removed wrapper key "command_plan" from top level.',
        'Coerced commands from string to array',
        LEGACY_TEST_COMMAND.warning,
      ],
      autoRetryCount: 1,
      validationError: 'No final test command marker found',
    })
    expect(result.structuredOutput.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'No final test command marker found',
        excerpt: expect.stringContaining('I added tests to cover the whole ticket.'),
      }),
    ])
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: 'I added tests to cover the whole ticket.' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: expect.stringContaining('<FINAL_TEST_COMMANDS>') }),
    ])
    expect(result.structuredOutput.interventions?.some((intervention) => intervention.category === 'parser_fix')).toBe(true)
    expect(result.structuredOutput.interventions?.some((intervention) => intervention.category === 'retry')).toBe(true)

    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(SILENT_DEFAULT_PERMISSIONS)
    expect(adapter.promptCalls[1]?.options?.permission).toEqual(SILENT_DEFAULT_PERMISSIONS)
  })

  it('restarts final test generation in a fresh session after an empty response', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-2#1', [
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'summary: verify end-to-end ticket coverage',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    const result = await generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      '/tmp/test',
    )

    expect(result.commandPlan).toEqual({
      markerFound: true,
      commands: [LEGACY_TEST_COMMAND.command],
      summary: 'verify end-to-end ticket coverage',
      testFiles: [],
      modifiedFiles: [],
      fileEffects: [],
      testsCount: null,
      errors: [],
      repairApplied: true,
      repairWarnings: [LEGACY_TEST_COMMAND.warning],
    })
    expect(result.output).toContain('<FINAL_TEST_COMMANDS>')
    expect(result.structuredOutput).toMatchObject({
      repairApplied: true,
      repairWarnings: [LEGACY_TEST_COMMAND.warning],
      autoRetryCount: 1,
      validationError: 'No final test command marker found',
    })
    expect(result.structuredOutput.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'No final test command marker found',
        excerpt: '[empty response]',
      }),
    ])
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: '', failureClass: 'empty_response' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: expect.stringContaining('<FINAL_TEST_COMMANDS>') }),
    ])
    expect(result.structuredOutput.interventions?.some((intervention) => intervention.category === 'retry')).toBe(true)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('restarts final test generation in a fresh session after a provider session error', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'summary: verify end-to-end ticket coverage',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))
    adapter.mockStreamEvents.set('mock-session-1#1', [{
      type: 'session_error',
      sessionId: 'mock-session-1',
      error: "Provider returned error: The last message cannot have role 'assistant'",
    }])
    adapter.mockResponses.set('mock-session-2#1', [
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'summary: verify end-to-end ticket coverage',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    const result = await generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      '/tmp/test',
    )

    expect(result.commandPlan.commands).toEqual([LEGACY_TEST_COMMAND.command])
    expect(result.structuredOutput).toMatchObject({
      autoRetryCount: 1,
      validationError: 'No final test command marker found',
    })
    expect(result.structuredOutput.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'No final test command marker found',
        failureClass: 'session_protocol_error',
        excerpt: '[empty response]',
      }),
    ])
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', failureClass: 'session_protocol_error' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: expect.stringContaining('<FINAL_TEST_COMMANDS>') }),
    ])
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('creates allow-all sessions for owned final-test attempts and fresh retries', async () => {
    resetTestDb()
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Owned final test session permissions',
    })
    patchTicket(ticket.id, { status: 'RUNNING_FINAL_TEST' })

    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-2#1', [
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'summary: verify end-to-end ticket coverage',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    const result = await generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      paths.worktreePath,
      undefined,
      {
        ticketId: ticket.id,
        model: 'model-a',
      },
    )

    expect(result.commandPlan.commands).toEqual([LEGACY_TEST_COMMAND.command])
    expect(adapter.sessionCreateCalls).toHaveLength(2)
    expect(adapter.sessionCreateCalls.every((call) => (
      JSON.stringify(call.options?.permission) === JSON.stringify(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
    ))).toBe(true)
  })

  it('dispatches final-test generation prompts with AI response timeout metadata', async () => {
    resetTestDb()
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Final test AI timeout metadata',
    })
    patchTicket(ticket.id, { status: 'RUNNING_FINAL_TEST' })

    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'summary: verify end-to-end ticket coverage',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))
    const dispatched: OpenCodePromptDispatchEvent[] = []

    await generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      paths.worktreePath,
      undefined,
      {
        ticketId: ticket.id,
        model: 'model-a',
        timeoutMs: 321_000,
        onPromptDispatched: ({ event }) => {
          dispatched.push(event)
        },
      },
    )

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      timeoutKind: 'ai_response',
      timeoutMs: 321_000,
      model: 'model-a',
    })
    expect(dispatched[0]?.deadlineAt).toEqual(expect.any(String))
  })

  it('times out hung final-test generation prompts on the AI response deadline', async () => {
    const adapter = new HangingPromptAdapter()
    const dispatched: OpenCodePromptDispatchEvent[] = []

    await expect(generateFinalTests(
      adapter,
      [{ type: 'text', content: 'Ticket context' }],
      '/tmp/test',
      undefined,
      {
        model: 'model-a',
        timeoutMs: 20,
        onPromptDispatched: ({ event }) => {
          dispatched.push(event)
        },
      },
    )).rejects.toThrow('Timeout')

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      timeoutKind: 'ai_response',
      timeoutMs: 20,
      model: 'model-a',
    })
    expect(adapter.promptCalls).toHaveLength(1)
  })
})
