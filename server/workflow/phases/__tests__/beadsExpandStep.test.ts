import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShellCommandSpec } from '@shared/commandSpec'
import { expandBeads } from '../../../phases/beads/expand'
import type { BeadSubset } from '../../../phases/beads/types'
import { TEST } from '../../../test/factories'
import { resetTestDb } from '../../../test/integration'
import { getStructuredRetryDiagnosticFromError } from '../../../lib/structuredRetryDiagnostics'

const { runOpenCodePromptMock } = vi.hoisted(() => ({
  runOpenCodePromptMock: vi.fn(),
}))

vi.mock('../../runOpenCodePrompt', () => ({
  runOpenCodePrompt: runOpenCodePromptMock,
}))

import { executeBeadsExpandStep } from '../beadsPhase'

const subset: BeadSubset = {
  id: 'draft-bead',
  title: 'Implement the feature',
  prdRefs: ['EPIC-1 / US-1'],
  description: 'Implement the approved feature.',
  contextGuidance: {
    patterns: ['Keep the change focused.'],
    anti_patterns: ['Do not change unrelated behavior.'],
  },
  acceptanceCriteria: ['The feature works.'],
  tests: ['Automated tests verify the feature.'],
  testCommands: [createShellCommandSpec('npm test')],
}

function response(overrides: Record<string, unknown> = {}) {
  const [bead] = expandBeads([subset], TEST.externalId)
  if (!bead) throw new Error('Expected an expanded bead')
  return JSON.stringify({
    ...bead,
    id: 'expanded-bead',
    labels: [`ticket:${TEST.externalId}`, 'epic:EPIC-1', 'story:US-1'],
    targetFiles: ['src/feature.ts'],
    ...overrides,
  })
}

function params() {
  return {
    ticketId: TEST.ticketId,
    externalId: TEST.externalId,
    phaseLabel: 'EXPANDING_BEADS' as const,
    worktreePath: '/tmp/worktree',
    winnerId: TEST.model,
    externalRef: TEST.externalId,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    ticketState: { ticketId: TEST.externalId, title: 'Test feature' },
    beadSubsets: [subset],
    modelVariant: 'high',
    onSessionLog: vi.fn(),
    onStreamEvent: vi.fn(),
    onPromptDispatched: vi.fn(),
  }
}

function queueResponses(responses: string[]) {
  runOpenCodePromptMock.mockImplementation(async (options) => {
    const session = { id: `session-${runOpenCodePromptMock.mock.calls.length}`, projectPath: options.projectPath }
    const event = {
      type: 'text',
      sessionId: session.id,
      messageId: 'message-1',
      partId: 'part-1',
      text: 'streamed response',
      streaming: false,
      complete: true,
    }
    options.onSessionCreated?.(session)
    options.onStreamEvent?.(event)
    options.onPromptDispatched?.({
      session,
      parts: options.parts,
      promptText: 'Expansion prompt',
      promptNumber: 1,
      timeoutKind: 'ai_response',
      model: options.model,
      variant: options.variant,
    })
    return { session, response: responses.shift() ?? '', messages: [] }
  })
}

describe('executeBeadsExpandStep', () => {
  beforeEach(() => {
    resetTestDb()
    runOpenCodePromptMock.mockReset()
  })

  it('returns hydrated beads and forwards prompt, session, and stream events', async () => {
    queueResponses([response()])
    const input = params()

    const result = await executeBeadsExpandStep(input)

    expect(result.hydratedBeads).toHaveLength(1)
    expect(result.hydratedBeads[0]).toMatchObject({
      id: 'expanded-bead',
      externalRef: TEST.externalId,
      targetFiles: ['src/feature.ts'],
      dependencies: { blocked_by: [], blocks: [] },
    })
    expect(JSON.parse(result.hydratedContent)).toEqual(result.hydratedBeads[0])
    expect(result.structuredMeta).toMatchObject({
      autoRetryCount: 0,
      repairApplied: true,
      repairWarnings: expect.arrayContaining([expect.stringContaining('testCommands[0]')]),
    })
    expect(runOpenCodePromptMock).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: input.worktreePath,
      timeoutMs: input.timeoutMs,
      timeoutKind: 'ai_response',
      model: TEST.model,
      variant: 'high',
      sessionOwnership: expect.objectContaining({
        ticketId: TEST.ticketId,
        phase: 'EXPANDING_BEADS',
        memberId: TEST.model,
        step: 'expand',
      }),
    }))
    expect(input.onSessionLog).toHaveBeenCalledWith(expect.objectContaining({
      memberId: TEST.model,
      sessionId: 'session-1',
      response: expect.any(String),
      messages: [],
    }))
    expect(input.onStreamEvent).toHaveBeenCalledWith(expect.objectContaining({
      memberId: TEST.model,
      sessionId: 'session-1',
      event: expect.objectContaining({ type: 'text' }),
    }))
    expect(input.onPromptDispatched).toHaveBeenCalledWith(expect.objectContaining({
      memberId: TEST.model,
      event: expect.objectContaining({ promptText: 'Expansion prompt' }),
    }))
  })

  it('retries preserved-field drift with correction guidance and returns the valid response', async () => {
    queueResponses([
      response({ title: 'A rewritten title' }),
      response(),
    ])

    const result = await executeBeadsExpandStep({ ...params(), maxStructuredRetries: 1 })

    expect(result.structuredMeta).toMatchObject({ autoRetryCount: 1, validationError: expect.stringContaining('changed preserved Part 1 fields') })
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    const retryParts = runOpenCodePromptMock.mock.calls[1]?.[0].parts
    expect(JSON.stringify(retryParts)).toContain('Preserved-field correction:')
    expect(JSON.stringify(retryParts)).toContain('Do not rewrite `title`')
  })

  it('throws after the configured retry limit and attaches the final structured diagnostic', async () => {
    queueResponses(['not-json', 'still not-json'])

    const error = await executeBeadsExpandStep({ ...params(), maxStructuredRetries: 1 })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(getStructuredRetryDiagnosticFromError(error)).toMatchObject({
      attempt: 1,
      validationError: expect.stringContaining('still not-json'),
    })
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
  })
})
