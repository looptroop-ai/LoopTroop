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

    const result = await generateExecutionSetupPlan(
      adapter,
      [{ type: 'text', content: 'Execution setup plan context' }],
      '/tmp/test',
    )

    expect(result.plan?.steps[0]?.title).toBe('Bootstrap project dependencies')
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
    expect(retryPrompt).toContain('workspace_inputs must list only concrete ignored or untracked files and directories needed by setup')
    expect(retryPrompt).toContain('steps and workspace_inputs must both be empty when readiness says the environment is ready')
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

  it('completes owned setup-plan sessions after a ready plan is parsed', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
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
    const { ticket } = createInitializedTestTicket(repoManager, {
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
