import { describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_EXECUTION_SETUP_ONLINE_TOOLS } from '../../../opencode/toolPolicy'
import { generateExecutionSetup } from '../generator'

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

    return await super.promptSession(...args)
  }
}

class FailingPromptAdapter extends MockOpenCodeAdapter {
  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>): Promise<string> {
    this.promptCalls.push({ sessionId: args[0], parts: args[1], options: args[3] })
    throw new Error('manual continuation prompt failed')
  }
}

function buildReadyExecutionSetupResponse(): string {
  return [
    '<EXECUTION_SETUP_RESULT>',
    'status: ready',
    'summary: environment initialized',
    'profile:',
    '  schema_version: 1',
    '  ticket_id: T-1',
    '  artifact: execution_setup_profile',
    '  status: ready',
    '  summary: environment initialized and reusable',
    '  temp_roots:',
    '    - .ticket/runtime/execution-setup',
    '    - .ticket/runtime/execution-setup/tool-cache',
    '  bootstrap_commands:',
    '    - project bootstrap',
    '  reusable_artifacts:',
    '    - path: .ticket/runtime/execution-setup/tool-cache/dependencies',
    '      kind: cache',
    '      purpose: project dependency cache',
    '  project_commands:',
    '    prepare:',
    '      - project bootstrap',
    '    test_full:',
    '      - project test',
    '    lint_full: []',
    '    typecheck_full: []',
    '  quality_gate_policy:',
    '    tests: bead-test-commands-first',
    '    lint: impacted-or-package',
    '    typecheck: impacted-or-package',
    '    full_project_fallback: never-block-on-unrelated-baseline',
    '  cautions: []',
    'checks:',
    '  workspace: pass',
    '  tooling: pass',
    '  temp_scope: pass',
    '  policy: pass',
    '</EXECUTION_SETUP_RESULT>',
  ].join('\n')
}

describe('generateExecutionSetup', () => {
  it('does not replace a failed manual continuation with the full setup prompt in a fresh session', async () => {
    const adapter = new FailingPromptAdapter()

    await expect(generateExecutionSetup(
      adapter,
      [{ type: 'text', content: 'Execution setup context' }],
      '/tmp/test',
      undefined,
      { manualContinuation: true },
    )).rejects.toThrow('manual continuation prompt failed')

    expect(adapter.sessions).toHaveLength(1)
    expect(adapter.promptCalls).toHaveLength(1)
  })

  it('retries near-valid markerless structured output in the same session', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', [
      'status: ready',
      'summary: environment initialized',
      'profile:',
      '  status: ready',
      'checks:',
      '  workspace: pass',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-1#2', [
      '<EXECUTION_SETUP_RESULT>',
      '```yaml',
      'execution_setup_result:',
      buildReadyExecutionSetupResponse()
        .replace('<EXECUTION_SETUP_RESULT>\n', '')
        .replace('\n</EXECUTION_SETUP_RESULT>', '')
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
      '```',
      '</EXECUTION_SETUP_RESULT>',
    ].join('\n'))

    const result = await generateExecutionSetup(
      adapter,
      [{ type: 'text', content: 'Execution setup context' }],
      '/tmp/test',
    )

    expect(result.result?.status).toBe('ready')
    expect(result.parse.repairApplied).toBe(true)
    expect(result.structuredOutput.autoRetryCount).toBe(1)
    expect(result.structuredOutput.retryDiagnostics?.[0]?.validationError).toBe('No execution setup result marker found')
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: expect.stringContaining('status: ready') }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: expect.stringContaining('<EXECUTION_SETUP_RESULT>') }),
    ])
    expect(adapter.promptCalls[0]?.options?.tools).toEqual(OPENCODE_EXECUTION_SETUP_ONLINE_TOOLS)
    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
  })

  it.each([
    { label: 'empty', response: '', failureClass: 'empty_response' },
    { label: 'progress-only', response: 'I am still preparing the environment.', failureClass: 'validation_error' },
  ] as const)('does not request structured correction for a $label markerless response', async ({ response, failureClass }) => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', response)
    adapter.mockResponses.set('mock-session-1#2', buildReadyExecutionSetupResponse())
    const structuredRetryStarts: Array<{ sessionId: string; retryAttempt: number }> = []

    const result = await generateExecutionSetup(
      adapter,
      [{ type: 'text', content: 'Execution setup context' }],
      '/tmp/test',
      undefined,
      {
        onStructuredRetryStart: entry => structuredRetryStarts.push(entry),
      },
    )

    expect(result.result).toBeNull()
    expect(result.structuredOutput.autoRetryCount).toBe(0)
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: response, failureClass }),
    ])
    expect(structuredRetryStarts).toEqual([])
    expect(adapter.promptCalls).toHaveLength(1)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('announces structured correction before dispatching the retry prompt', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'status: ready\nsummary: missing marker')
    adapter.mockResponses.set('mock-session-1#2', buildReadyExecutionSetupResponse())
    const retryStarts: Array<{
      sessionId: string
      retryAttempt: number
      promptCount: number
    }> = []

    const result = await generateExecutionSetup(
      adapter,
      [{ type: 'text', content: 'Execution setup context' }],
      '/tmp/test',
      undefined,
      {
        onStructuredRetryStart: ({ sessionId, retryAttempt }) => {
          retryStarts.push({
            sessionId,
            retryAttempt,
            promptCount: adapter.promptCalls.length,
          })
        },
      },
    )

    expect(result.result?.status).toBe('ready')
    expect(retryStarts).toEqual([{
      sessionId: 'mock-session-1',
      retryAttempt: 1,
      promptCount: 1,
    }])
    expect(adapter.promptCalls).toHaveLength(2)
  })

  it('restarts execution setup in a fresh session after a session protocol error', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', buildReadyExecutionSetupResponse())
    adapter.mockStreamEvents.set('mock-session-1#1', [{
      type: 'session_error',
      sessionId: 'mock-session-1',
      error: "Provider returned error: The last message cannot have role 'assistant'",
    }])
    adapter.mockResponses.set('mock-session-2#1', buildReadyExecutionSetupResponse())

    const result = await generateExecutionSetup(
      adapter,
      [{ type: 'text', content: 'Execution setup context' }],
      '/tmp/test',
    )

    expect(result.result?.status).toBe('ready')
    expect(result.structuredOutput.retryDiagnostics?.[0]).toMatchObject({
      failureClass: 'session_protocol_error',
      validationError: 'No execution setup result marker found',
    })
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', failureClass: 'session_protocol_error' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: buildReadyExecutionSetupResponse() }),
    ])
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
  })
})
