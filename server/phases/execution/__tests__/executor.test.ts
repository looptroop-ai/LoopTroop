import { afterAll, describe, expect, it, vi } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../../../opencode/permissions'
import { executeBead } from '../executor'
import type { Bead } from '../../beads/types'
import { PROFILE_DEFAULTS } from '../../../db/defaults'
import { patchTicket } from '../../../storage/tickets'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { createShellCommandSpec } from '@shared/commandSpec'
import {
  BEAD_AGENT_RESPONSE_INVALID,
  BEAD_ITERATION_TIMEOUT,
  BEAD_RETRY_BUDGET_EXHAUSTED,
  OPENCODE_PROVIDER_ERROR,
} from '../../../../shared/errorCodes'

class SequencedMockOpenCodeAdapter extends MockOpenCodeAdapter {
  private promptCounts = new Map<string, number>()
  public abortCalls: string[] = []
  public promptFailures = new Map<string, Error | 'stallUntilAbort'>()

  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>) {
    const sessionId = args[0]
    const nextCount = (this.promptCounts.get(sessionId) ?? 0) + 1
    this.promptCounts.set(sessionId, nextCount)

    const queuedFailure = this.promptFailures.get(`${sessionId}#${nextCount}`)
    if (queuedFailure) {
      this.promptFailures.delete(`${sessionId}#${nextCount}`)
      this.promptCalls.push({
        sessionId,
        parts: args[1],
        options: args[3],
      })
      if (queuedFailure === 'stallUntilAbort') {
        const activeSignal = args[3]?.signal ?? args[2]
        if (!activeSignal) {
          throw new Error(`Missing abort signal for stalled prompt ${sessionId}#${nextCount}`)
        }
        if (activeSignal.aborted) {
          const abortError = new Error('Aborted')
          abortError.name = 'AbortError'
          throw abortError
        }
        await new Promise<never>((_, reject) => {
          const onAbort = () => {
            const abortError = new Error('Aborted')
            abortError.name = 'AbortError'
            reject(abortError)
          }
          activeSignal.addEventListener('abort', onAbort, { once: true })
        })
      }
      throw queuedFailure
    }

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

  override async abortSession(sessionId: string): Promise<boolean> {
    this.abortCalls.push(sessionId)
    return await super.abortSession(sessionId)
  }
}

function buildBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'bead-1',
    title: 'Normalize structured outputs',
    prdRefs: ['EPIC-1 / US-1'],
    description: 'Repair machine-readable marker mistakes before failing.',
    contextGuidance: { patterns: ['Keep the retry limited to marker correction only.'], anti_patterns: ['Do not retry for non-marker issues.'] },
    acceptanceCriteria: ['Repairable marker formatting does not fail the iteration immediately.'],
    tests: ['Structured marker retry is covered by tests.'],
    testCommands: [],
    priority: 1,
    status: 'pending',
    issueType: 'task',
    externalRef: '',
    labels: [],
    dependencies: { blocked_by: [], blocks: [] },
    targetFiles: [],
    failedIterationNotes: [],
    userRetryNotes: [],
    finalizationFailureNotes: [],
    iteration: 1,
    createdAt: '',
    updatedAt: '',
    completedAt: '',
    startedAt: '',
    beadStartCommit: null,
    ...overrides,
  }
}

const repoManager = createTestRepoManager('execution-executor-')

describe('executeBead', () => {
  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('accepts the agent completion marker without independently running declared commands', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    const doneMarker = [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n')
    adapter.mockResponses.set('mock-session-1#1', doneMarker)
    const result = await executeBead(
      adapter,
      buildBead({ testCommands: [createShellCommandSpec('node -e "process.exit(1)"')] }),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
      PROFILE_DEFAULTS.perIterationTimeout,
    )

    expect(result.success).toBe(true)
    expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['mock-session-1'])
  })

  it('retries malformed completion markers in the same session', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'Implemented the bead and ran the checks successfully.')
    adapter.mockResponses.set('mock-session-1#2', [
      '<BEAD_STATUS>',
      '```yaml',
      'beadStatus:',
      '  beadId: bead-1',
      '  status: completed',
      '  gates:',
      '    test: pass',
      '    lint: pass',
      '    type_check: pass',
      '    qualitative_review: pass',
      '```',
      '</BEAD_STATUS>',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-1#3', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(1)
    expect(result.output).toContain('<BEAD_STATUS>')

    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
  })

  it('uses PROM_CODING template for prompt construction', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    // Check the prompt included PROM_CODING template elements
    const messages = adapter.messages.get('mock-session-1') ?? []
    const firstPrompt = messages[0]?.content
    expect(typeof firstPrompt).toBe('string')
    expect(firstPrompt).toContain('BEAD_STATUS')
    expect(firstPrompt).toContain('System Role')
    expect(firstPrompt).toContain('quality gates')
    expect(result.rawAttempts).toHaveLength(1)
    expect(result.rawAttempts?.[0]).toMatchObject({
      attempt: 1,
      iteration: 1,
      status: 'accepted',
      outcome: 'accepted',
      rawResponse: result.output,
      modelOutput: result.output,
    })
    expect(result.rawAttempts?.[0]?.initialInput).toContain('BEAD_STATUS')
  })

  it('forwards Manual QA image evidence as SDK file parts', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const imagePart = {
      type: 'file' as const,
      content: '',
      source: 'manual_qa_evidence:item-1:evidence-1',
      url: 'file:///contained/screenshot.png',
      mime: 'image/png',
      filename: 'screenshot.png',
    }
    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }, imagePart],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    expect(adapter.promptCalls[0]?.parts).toEqual(expect.arrayContaining([imagePart]))
    const textPart = adapter.promptCalls[0]?.parts.find((part) => part.type === 'text')
    expect(textPart?.content).not.toContain('manual_qa_evidence')
  })

  it('continues the same session when the model reports status:error before eventually succeeding', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"error","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"},"reason":"lint still failing"}',
      '</BEAD_STATUS>',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-1#2', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Continue Bead Execution'))).toBe(true)
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Do not reply with a plain-text progress update or plan'))).toBe(true)
  })

  it('treats per-iteration timeout 0 as no deadline across continuation prompts', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"error","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"},"reason":"needs one more edit"}',
      '</BEAD_STATUS>',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-1#2', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
      0,
    )

    expect(result.success).toBe(true)
    expect(adapter.abortCalls).toEqual([])
    expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['mock-session-1', 'mock-session-1'])
  })

  it('calls onContextWipe when iteration fails and PROM51 generates notes', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.promptFailures.set('mock-session-1#1', new Error('tests still failing'))
    adapter.mockResponses.set('mock-session-1#2', '\u001b[31mIteration 1 failed because: no completion marker output.\u001b[0m')

    const notesUpdates: { beadId: string; failedIterationNotes: Bead['failedIterationNotes'] }[] = []
    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
      PROFILE_DEFAULTS.perIterationTimeout,
      undefined,
      {
        onContextWipe: async ({ beadId, failedIterationNotes }) => {
          notesUpdates.push({ beadId, failedIterationNotes })
        },
      },
    )

    expect(result.success).toBe(false)
    expect(notesUpdates).toHaveLength(1)
    expect(notesUpdates[0]!.beadId).toBe('bead-1')
    expect(notesUpdates[0]!.failedIterationNotes[0]?.content).toContain('failed')
    expect(notesUpdates[0]!.failedIterationNotes[0]?.content).not.toContain('\u001b[')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
    expect(result.rawAttempts).toHaveLength(1)
    expect(result.rawAttempts?.[0]).toMatchObject({
      attempt: 1,
      iteration: 1,
      status: 'failed',
      outcome: 'failed',
    })
    expect(result.rawAttempts?.[0]?.initialInput).toContain('BEAD_STATUS')
    expect(result.rawAttempts?.[0]?.error).toContain('tests still failing')
  })

  it('preserves usage-limit retry diagnostics when completion markers exhaust the bead window', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-1#2', 'Attempt stalled because the provider usage limit was reached.')
    adapter.mockStreamEvents.set('mock-session-1#1', [
      {
        type: 'session_status',
        sessionId: 'mock-session-1',
        status: 'retry',
        attempt: 1,
        message: 'The usage limit has been reached',
      },
      {
        type: 'session_status',
        sessionId: 'mock-session-1',
        status: 'retry',
        attempt: 2,
        message: 'The usage limit has been reached',
      },
    ])

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
      PROFILE_DEFAULTS.perIterationTimeout,
      undefined,
      {
        model: 'openai/gpt-5.2',
        structuredRetryCount: 0,
        opencodeRetryPolicy: { limit: 50, delayMs: 0 },
      },
    )

    expect(result.success).toBe(false)
    expect(result.errorCodes).toEqual([
      BEAD_RETRY_BUDGET_EXHAUSTED,
      BEAD_AGENT_RESPONSE_INVALID,
      OPENCODE_PROVIDER_ERROR,
    ])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'The usage limit has been reached',
      modelId: 'openai/gpt-5.2',
      sessionId: 'mock-session-1',
    })
    expect(result.errors).toContain('Iteration 1: No completion marker found')
    expect(result.errors).toContain('Iteration 1: Completion marker failed validation after 0 structured retry attempt(s): No completion marker found')
  })

  it('creates allow-all sessions for owned coding attempts', async () => {
    resetTestDb()
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Owned coding session permissions',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      paths.worktreePath,
      1,
      PROFILE_DEFAULTS.perIterationTimeout,
      undefined,
      {
        ticketId: ticket.id,
        model: 'model-a',
      },
    )

    expect(result.success).toBe(true)
    expect(adapter.sessionCreateCalls).toHaveLength(1)
    expect(adapter.sessionCreateCalls[0]?.options?.permission).toEqual(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
  })

  it('recreates allow-all sessions on fresh owned coding retries', async () => {
    resetTestDb()
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Owned coding session retries',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      paths.worktreePath,
      1,
      PROFILE_DEFAULTS.perIterationTimeout,
      undefined,
      {
        ticketId: ticket.id,
        model: 'model-a',
      },
    )

    expect(result.success).toBe(true)
    expect(adapter.sessionCreateCalls).toHaveLength(2)
    expect(adapter.sessionCreateCalls.every((call) => (
      JSON.stringify(call.options?.permission) === JSON.stringify(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
    ))).toBe(true)
  })

  it('restarts the bead iteration in a fresh session after an empty completion response', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      'bead_id: bead-1',
      'status: completed',
      'checks:',
      '  tests: pass',
      '  lint: pass',
      '  typecheck: pass',
      '  qualitative: pass',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(1)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('restarts the bead iteration in a fresh session after a provider session error', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))
    adapter.mockStreamEvents.set('mock-session-1#1', [{
      type: 'session_error',
      sessionId: 'mock-session-1',
      error: "Provider returned error: The last message cannot have role 'assistant'",
    }])
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(1)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('rebuilds bead context for the next iteration after PROM51 notes are appended', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.promptFailures.set('mock-session-1#1', new Error('missing final fix'))
    adapter.mockResponses.set('mock-session-1#2', 'Retry with the new note about the missing completion marker.')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const bead = buildBead()
    const contextSnapshots: string[] = []
    const result = await executeBead(
      adapter,
      bead,
      async () => {
        const notes = bead.failedIterationNotes.map((entry) => entry.content).join('\n')
        contextSnapshots.push(notes)
        return [{ type: 'text', content: notes ? `Bead context\n${notes}` : 'Bead context' }]
      },
      '/tmp/test',
      2,
      PROFILE_DEFAULTS.perIterationTimeout,
    )

    expect(result.success).toBe(true)
    expect(contextSnapshots).toHaveLength(2)
    expect(contextSnapshots[0]).toBe('')
    expect(contextSnapshots[1]).toContain('Retry with the new note')
  })

  it('starts a recovered bead from the persisted next iteration instead of resetting to 1', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const sessionIterations: number[] = []
    const result = await executeBead(
      adapter,
      buildBead({ iteration: 6 }),
      [{ type: 'text', content: 'Recovered bead context' }],
      '/tmp/test',
      5,
      PROFILE_DEFAULTS.perIterationTimeout,
      undefined,
      {
        onSessionCreated: (_sessionId, iteration) => {
          sessionIterations.push(iteration)
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(6)
    expect(sessionIterations).toEqual([6])
  })

  it('exhausts a recovered bead retry window at the correct absolute iteration', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new SequencedMockOpenCodeAdapter()
      for (let index = 1; index <= 5; index += 1) {
        adapter.promptFailures.set(`mock-session-${index}#1`, 'stallUntilAbort')
        adapter.mockResponses.set(`mock-session-${index}#2`, `Recovered bead note ${index}`)
      }

      const runPromise = executeBead(
        adapter,
        buildBead({ iteration: 6 }),
        [{ type: 'text', content: 'Recovered bead context' }],
        '/tmp/test',
        5,
        1,
      )

      await vi.runAllTimersAsync()
      const result = await runPromise

      expect(result.success).toBe(false)
      expect(result.iteration).toBe(10)
      expect(result.errorCodes).toEqual([BEAD_RETRY_BUDGET_EXHAUSTED, BEAD_ITERATION_TIMEOUT])
      expect(result.errors).toContain('Reached the configured per-bead retry budget at iteration 10.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses the timed-out session for PROM51 before starting the next coding session', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.promptFailures.set('mock-session-1#1', 'stallUntilAbort')
    adapter.mockResponses.set('mock-session-1#2', 'Timeout note from the stalled session.')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const bead = buildBead()
    const contextSnapshots: string[] = []
    const result = await executeBead(
      adapter,
      bead,
      async () => {
        const notes = bead.failedIterationNotes.map((entry) => entry.content).join('\n')
        contextSnapshots.push(notes)
        return [{ type: 'text', content: notes ? `Bead context\n${notes}` : 'Bead context' }]
      },
      '/tmp/test',
      2,
      25,
    )

    expect(result.success).toBe(true)
    expect(adapter.abortCalls).toEqual(['mock-session-1'])
    expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual([
      'mock-session-1',
      'mock-session-1',
      'mock-session-2',
    ])
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(contextSnapshots).toHaveLength(2)
    expect(contextSnapshots[0]).toBe('')
    expect(contextSnapshots[1]).toContain('Timeout note from the stalled session.')

    const timeoutNotePrompt = adapter.promptCalls[1]?.parts[0]?.content
    expect(typeof timeoutNotePrompt).toBe('string')
    expect(timeoutNotePrompt).toContain('EXISTING SESSION:')
    expect(timeoutNotePrompt).not.toContain('CONTEXT REFRESH:')
  })

  it('treats owned coding iteration timeout as context wipe instead of continuable session preservation', async () => {
    resetTestDb()
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Owned coding timeout reset',
    })
    patchTicket(ticket.id, { status: 'CODING' })

    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.promptFailures.set('mock-session-1#1', 'stallUntilAbort')
    adapter.mockResponses.set('mock-session-1#2', 'Timeout note from owned stalled session.')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const contextWipes: Array<{ reason: string; attempt: number; nextAttempt: number; maxAttempts: number | null }> = []
    const preservedTimeouts: string[] = []
    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      paths.worktreePath,
      2,
      25,
      undefined,
      {
        ticketId: ticket.id,
        model: 'model-a',
        onContextWipe: async ({ reason, attempt, nextAttempt, maxAttempts }) => {
          contextWipes.push({ reason, attempt, nextAttempt, maxAttempts })
        },
        onContinuableTimeoutPreserved: ({ message }) => {
          preservedTimeouts.push(message)
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(2)
    expect(result.rawAttempts).toMatchObject([
      {
        attempt: 1,
        iteration: 1,
        status: 'timed_out',
        outcome: 'timed_out',
      },
      {
        attempt: 2,
        iteration: 2,
        status: 'accepted',
        outcome: 'accepted',
      },
    ])
    expect(result.rawAttempts?.[0]?.initialInput).toContain('BEAD_STATUS')
    expect(result.rawAttempts?.[0]?.errorCodes).toContain(BEAD_ITERATION_TIMEOUT)
    expect(result.rawAttempts?.[1]?.rawResponse).toContain('"status":"done"')
    expect(contextWipes).toEqual([
      { reason: 'iteration_timeout', attempt: 1, nextAttempt: 2, maxAttempts: 2 },
    ])
    expect(preservedTimeouts).toEqual([])
    expect(adapter.abortCalls).toEqual(['mock-session-1'])
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
  }, 40_000)

  it('reports an iteration timeout code when the coding retry budget is exhausted', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.promptFailures.set('mock-session-1#1', 'stallUntilAbort')
    adapter.mockResponses.set('mock-session-1#2', 'Timeout note from stalled session.')

    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      1,
      25,
    )

    expect(result.success).toBe(false)
    expect(result.errorCodes).toEqual([BEAD_RETRY_BUDGET_EXHAUSTED, BEAD_ITERATION_TIMEOUT])
  }, 40_000)

  it('resets and retries when the per-iteration timeout expires during a continuation prompt', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"error","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"},"reason":"one more step"}',
      '</BEAD_STATUS>',
    ].join('\n'))
    adapter.promptFailures.set('mock-session-1#2', 'stallUntilAbort')
    adapter.mockResponses.set('mock-session-1#3', 'Timeout note after continuation stalled.')
    adapter.mockResponses.set('mock-session-2#1', [
      '<BEAD_STATUS>',
      '{"bead_id":"bead-1","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}',
      '</BEAD_STATUS>',
    ].join('\n'))

    const contextWipeReasons: string[] = []
    const result = await executeBead(
      adapter,
      buildBead(),
      [{ type: 'text', content: 'Bead context' }],
      '/tmp/test',
      2,
      25,
      undefined,
      {
        onContextWipe: async ({ reason }) => {
          contextWipeReasons.push(reason)
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.iteration).toBe(2)
    expect(contextWipeReasons).toEqual(['iteration_timeout'])
    expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual([
      'mock-session-1',
      'mock-session-1',
      'mock-session-1',
      'mock-session-2',
    ])
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
  })

  it('uses the configured profile default timeout when no bead timeout is passed explicitly', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new SequencedMockOpenCodeAdapter()
      adapter.promptFailures.set('mock-session-1#1', 'stallUntilAbort')
      adapter.mockResponses.set('mock-session-1#2', 'Timed out using the profile default timeout.')

      const runPromise = executeBead(
        adapter,
        buildBead(),
        [{ type: 'text', content: 'Bead context' }],
        '/tmp/test',
        1,
      )

      await vi.advanceTimersByTimeAsync(PROFILE_DEFAULTS.perIterationTimeout - 1)
      expect(adapter.abortCalls).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      const result = await runPromise

      expect(result.success).toBe(false)
      expect(adapter.abortCalls).toEqual(['mock-session-1'])
    } finally {
      vi.useRealTimers()
    }
  })
})
