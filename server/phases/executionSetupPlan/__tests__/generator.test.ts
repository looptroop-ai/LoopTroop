import { afterAll, describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { listOpenCodeSessionsForTicket } from '../../../opencode/sessionManager'
import { patchTicket } from '../../../storage/tickets'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import type { OpenCodePromptDispatchEvent } from '../../../workflow/runOpenCodePrompt'
import { generateExecutionSetupPlan } from '../generator'

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
    const queuedAssistantInfo = this.mockAssistantInfos.get(`${sessionId}#${nextCount}`)
    if (queuedAssistantInfo !== undefined) {
      this.mockAssistantInfos.set(sessionId, queuedAssistantInfo)
    }

    return await super.promptSession(...args)
  }
}

function buildReadyPlanResponse(): string {
  return [
    '<EXECUTION_SETUP_PLAN>',
    'schema_version: 1',
    'ticket_id: T-1',
    'artifact: execution_setup_plan',
    'status: draft',
    'summary: Workspace setup is ready for review.',
    'readiness:',
    '  status: partial',
    '  actions_required: true',
    '  evidence:',
    '    - Project manifest exists.',
    '  gaps:',
    '    - Dependencies are missing.',
    'temp_roots:',
    '  - .ticket/runtime/execution-setup',
    'steps:',
    '  - id: setup-step-1',
    '    title: Bootstrap project dependencies',
    '    purpose: Install dependencies before running project-native tests.',
    '    commands:',
    '      - project bootstrap',
    '    required: true',
    '    rationale: Project-native tests require installed dependencies.',
    '    cautions: []',
    'project_commands:',
    '  prepare:',
    '    - project bootstrap',
    '  test_full:',
    '    - project test',
    '  lint_full: []',
    '  typecheck_full: []',
    'quality_gate_policy:',
    '  tests: bead-test-commands-first',
    '  lint: impacted-or-package',
    '  typecheck: impacted-or-package',
    '  full_project_fallback: never-block-on-unrelated-baseline',
    'cautions: []',
    '</EXECUTION_SETUP_PLAN>',
  ].join('\n')
}

describe('generateExecutionSetupPlan', () => {
  const repoManager = createTestRepoManager('execution-setup-plan-generator-')

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('includes required setup step fields in the structured retry reminder', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'I drafted the setup plan.')
    adapter.mockResponses.set('mock-session-1#2', buildReadyPlanResponse())
    const createdSessions: string[] = []
    const streamedEvents: Array<{ sessionId: string; event: { type: string } }> = []
    const completedStages: string[] = []

    const result = await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      {
        onSessionCreated: (sessionId) => createdSessions.push(sessionId),
        onOpenCodeStreamEvent: (entry) => streamedEvents.push(entry),
        onPromptCompleted: ({ stage }) => completedStages.push(stage),
      },
    )

    expect(result.plan?.steps[0]?.title).toBe('Bootstrap project dependencies')
    expect(createdSessions).toEqual(['mock-session-1'])
    expect(streamedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'mock-session-1', event: expect.objectContaining({ type: 'text' }) }),
      expect.objectContaining({ sessionId: 'mock-session-1', event: expect.objectContaining({ type: 'done' }) }),
    ]))
    expect(completedStages).toEqual(['execution_setup_plan_main', 'execution_setup_plan_structured_retry'])
    expect(result.structuredOutput.autoRetryCount).toBe(1)
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: 'I drafted the setup plan.' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: buildReadyPlanResponse() }),
    ])
    expect(result.rawAttempts?.[0]?.initialInput).toContain('Execution setup plan context')
    expect(result.rawAttempts?.[0]?.initialInput).not.toContain('Structured Output Retry')
    expect(result.rawAttempts?.[1]?.initialInput).toBeUndefined()

    const messages = adapter.messages.get('mock-session-1') ?? []
    const retryPrompt = messages.find((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Structured Output Retry')
    ))?.content

    expect(retryPrompt).toContain('Every setup step must include id, title, purpose, commands, required, rationale, and cautions')
    expect(retryPrompt).toContain('workspace_inputs must list only concrete ignored or untracked non-reproducible files and directories needed by setup, including category')
    expect(retryPrompt).toContain('LoopTroop supplies ticket identity, schema/artifact/status, temp roots, host facts')
  })

  it('uses the structured retry loop to replace a semantically incompatible plan', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', buildReadyPlanResponse())
    adapter.mockResponses.set('mock-session-1#2', buildReadyPlanResponse().replace(
      'summary: Workspace setup is ready for review.',
      'summary: The additional semantic plan check is now satisfied.',
    ))
    let validationCount = 0

    const result = await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      {
        validatePlan: () => {
          validationCount += 1
          return validationCount === 1
            ? ['The generated plan needs one additional semantic correction']
            : []
        },
      },
    )

    expect(result.plan?.summary).toBe('The additional semantic plan check is now satisfied.')
    expect(result.structuredOutput.autoRetryCount).toBe(1)
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'rejected',
        validationError: expect.stringContaining('additional semantic correction'),
      }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted' }),
    ])
    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => (
      typeof message.content === 'string'
      && message.content.includes('The generated plan needs one additional semantic correction')
    ))).toBe(true)
  })

  it('starts a fresh owned session when OpenCode reports an errored assistant response', async () => {
    resetTestDb()
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Replace errored setup plan session',
    })
    patchTicket(ticket.id, { status: 'WAITING_EXECUTION_SETUP_APPROVAL' })
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'provider error response')
    adapter.mockAssistantInfos.set('mock-session-1#1', { error: new Error('provider returned error') })
    adapter.mockResponses.set('mock-session-2#1', buildReadyPlanResponse())

    const result = await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      { ticketId: ticket.id },
    )

    expect(result.plan?.summary).toBe('Workspace setup is ready for review.')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((session) => session.sessionId))
      .toEqual(['mock-session-1'])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['completed']).map((session) => session.sessionId))
      .toEqual(['mock-session-2'])
  })

  it('fails closed when it cannot confirm cleanup of an invalid terminal response', async () => {
    const adapter = new MockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', 'not a setup plan')
    adapter.abortSession = async () => {
      throw new Error('OpenCode is unavailable')
    }

    await expect(generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      { structuredRetryCount: 0 },
    )).rejects.toThrow('Could not confirm abort of OpenCode session mock-session-1')
  })

  it('cleans up the active session and propagates a structured retry failure', async () => {
    class RetryFailureAdapter extends MockOpenCodeAdapter {
      private promptCount = 0

      override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>): Promise<string> {
        this.promptCount += 1
        if (this.promptCount === 2) throw new Error('Structured retry failed')
        return await super.promptSession(...args)
      }
    }

    const adapter = new RetryFailureAdapter()
    adapter.mockResponses.set('mock-session-1', 'not a setup plan')

    await expect(generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
    )).rejects.toThrow('Structured retry failed')
  })

  it('aborts the created session and preserves an initial prompt failure', async () => {
    class FailingPromptAdapter extends MockOpenCodeAdapter {
      readonly abortedSessions: string[] = []

      override async promptSession(..._args: Parameters<MockOpenCodeAdapter['promptSession']>): Promise<string> {
        throw new Error('OpenCode prompt failed')
      }

      override async abortSession(sessionId: string): Promise<boolean> {
        this.abortedSessions.push(sessionId)
        return true
      }
    }

    const adapter = new FailingPromptAdapter()
    const createdSessions: string[] = []

    await expect(generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      { onSessionCreated: (sessionId) => createdSessions.push(sessionId) },
    )).rejects.toThrow('OpenCode prompt failed')

    expect(createdSessions).toEqual(['mock-session-1'])
    expect(adapter.abortedSessions).toContain('mock-session-1')
  })

  it('completes owned setup-plan sessions after a ready plan is parsed', async () => {
    resetTestDb()
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Complete setup plan session',
    })
    patchTicket(ticket.id, { status: 'WAITING_EXECUTION_SETUP_APPROVAL' })
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', buildReadyPlanResponse())
    const dispatched: OpenCodePromptDispatchEvent[] = []

    await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      {
        ticketId: ticket.id,
        model: 'mock-model',
        timeoutMs: 234_000,
        onPromptDispatched: ({ event }) => {
          dispatched.push(event)
        },
      },
    )

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      timeoutKind: 'ai_response',
      timeoutMs: 234_000,
      model: 'mock-model',
    })
    expect(dispatched[0]?.deadlineAt).toEqual(expect.any(String))
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(0)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['completed'])).toHaveLength(1)
  })

  it('abandons owned setup-plan sessions after an invalid terminal result', async () => {
    resetTestDb()
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Abandon setup plan session',
    })
    patchTicket(ticket.id, { status: 'WAITING_EXECUTION_SETUP_APPROVAL' })
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'not a setup plan')
    adapter.mockResponses.set('mock-session-1#2', 'still not a setup plan')

    const result = await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
      undefined,
      {
        ticketId: ticket.id,
        model: 'mock-model',
      },
    )

    expect(result.plan).toBeNull()
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: 'not a setup plan' }),
      expect.objectContaining({ attempt: 2, outcome: 'rejected', rawResponse: 'still not a setup plan' }),
    ])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(0)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned'])).toHaveLength(1)
  })
})
