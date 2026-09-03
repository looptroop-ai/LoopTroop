import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { parseUiRefinementDiffArtifact } from '@shared/refinementDiffArtifacts'
import type { DraftPhaseResult, DraftProgressEvent } from '../../council/types'
import { attachProject } from '../../storage/projects'
import { createTicket, getLatestPhaseArtifact, getTicketPaths } from '../../storage/tickets'
import { TEST, makeTicketContextFromTicket as makeTicketContext } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { initializeTicket } from '../../ticket/initialize'
import { phaseIntermediate } from '../phases/state'

const { deliberateInterviewMock, refineDraftMock } = vi.hoisted(() => ({
  deliberateInterviewMock: vi.fn(),
  refineDraftMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({
    checkHealth: async () => ({ available: true, version: 'test' }),
  }),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../phases/interview/deliberate', () => ({
  deliberateInterview: deliberateInterviewMock,
}))

vi.mock('../../council/refiner', () => ({
  refineDraft: refineDraftMock,
}))

import { handleInterviewCompile, handleInterviewDeliberate } from '../phases/interviewPhase'

const repoManager = createTestRepoManager('interview-compile')

function readExecutionLogEntries(ticketId: string) {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Missing ticket paths for ${ticketId}`)
  return readFileSync(paths.executionLogPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function buildInterviewDraftContent(question: string) {
  return [
    'questions:',
    '  - id: Q01',
    '    phase: Foundation',
    `    question: "${question}"`,
  ].join('\n')
}

describe('interview workflow phases', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    deliberateInterviewMock.mockReset()
    refineDraftMock.mockReset()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('persists live interview draft parser metadata for the Council Drafting Questions status', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Show live interview parser notices',
    })
    const sendEvent = vi.fn()
    const repairedContent = buildInterviewDraftContent('Which constraints are fixed?')
    const repairedRawResponse = `\`\`\`yaml\n${repairedContent}\n\`\`\``
    const cleanContent = buildInterviewDraftContent('Which edge cases matter?')
    const repairedStructuredOutput = {
      repairApplied: true,
      repairWarnings: ['Removed surrounding markdown code fence before parsing interview questions.'],
      autoRetryCount: 1,
      validationError: 'Interview draft output was wrapped in markdown.',
      retryDiagnostics: [
        {
          attempt: 1,
          validationError: 'Interview draft output was wrapped in markdown.',
          excerpt: '```yaml\nquestions:',
        },
      ],
    }

    deliberateInterviewMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: unknown,
      _ticketContext: unknown,
      _worktreePath: unknown,
      _options: unknown,
      _signal: unknown,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onDraftProgress?: (entry: DraftProgressEvent) => void,
    ): Promise<DraftPhaseResult> => {
      onDraftProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'finished',
        outcome: 'completed',
        duration: 42,
        content: repairedContent,
        questionCount: 1,
        rawResponse: repairedRawResponse,
        normalizedResponse: repairedContent,
        structuredOutput: repairedStructuredOutput,
      })

      const liveCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_drafts', 'COUNCIL_DELIBERATING')
      const liveCompanion = parseUiArtifactCompanionArtifact(liveCompanionRow!.content)?.payload as {
        draftDetails?: Array<{
          memberId?: string
          structuredOutput?: {
            repairApplied?: boolean
            repairWarnings?: string[]
            autoRetryCount?: number
            validationError?: string
          }
          rawResponse?: string
          normalizedResponse?: string
        }>
      } | undefined
      expect(liveCompanion?.draftDetails?.[0]?.memberId).toBe(TEST.councilMembers[0])
      expect(liveCompanion?.draftDetails?.[0]?.rawResponse).toBe(repairedRawResponse)
      expect(liveCompanion?.draftDetails?.[0]?.normalizedResponse).toBe(repairedContent)
      expect(liveCompanion?.draftDetails?.[0]?.structuredOutput).toMatchObject({
        repairApplied: true,
        repairWarnings: ['Removed surrounding markdown code fence before parsing interview questions.'],
        autoRetryCount: 1,
        validationError: 'Interview draft output was wrapped in markdown.',
      })

      onDraftProgress?.({
        memberId: TEST.councilMembers[1],
        status: 'finished',
        outcome: 'completed',
        duration: 31,
        content: cleanContent,
        questionCount: 1,
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 0,
        },
      })

      return {
        phase: 'interview_draft',
        drafts: [
          {
            memberId: TEST.councilMembers[0],
            outcome: 'completed',
            duration: 42,
            content: repairedContent,
            questionCount: 1,
            rawResponse: repairedRawResponse,
            normalizedResponse: repairedContent,
            structuredOutput: repairedStructuredOutput,
          },
          {
            memberId: TEST.councilMembers[1],
            outcome: 'completed',
            duration: 31,
            content: cleanContent,
            questionCount: 1,
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 0,
            },
          },
        ],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
      }
    })

    await handleInterviewDeliberate(ticket.id, context, sendEvent, new AbortController().signal)

    const finalCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_drafts', 'COUNCIL_DELIBERATING')
    const finalCompanion = parseUiArtifactCompanionArtifact(finalCompanionRow!.content)?.payload as {
      draftDetails?: Array<{
        structuredOutput?: {
          interventions?: Array<{ category?: string; code?: string }>
        }
      }>
    } | undefined
    expect(finalCompanion?.draftDetails?.[0]?.structuredOutput?.interventions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'parser_fix' }),
      expect.objectContaining({ category: 'retry' }),
    ]))

    const executionLog = readFileSync(paths.executionLogPath, 'utf-8')
    expect(executionLog).toContain('Interview draft normalization applied repairs')
    expect(executionLog).toContain('Interview draft required 1 structured retry attempt(s)')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'QUESTIONS_READY', result: expect.any(Object) })
  })

  it('persists interview ui refinement diffs from parsed inline changes so inspiration tooltips survive slimming', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Restore interview inspiration tooltip',
      description: 'Keep prompt output single-source while saving UI-only inspiration metadata separately.',
    })

    initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    const winnerDraftContent = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "Original winner question?"',
      '  - id: Q02',
      '    phase: Structure',
      '    question: "Winner replacement source question?"',
    ].join('\n')

    const losingDraftContent = [
      'questions:',
      '  - id: Q07',
      '    phase: Structure',
      '    question: "Alternative draft replacement question?"',
    ].join('\n')

    const rawRefinementOutput = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "Refined winner question?"',
      '  - id: Q03',
      '    phase: Structure',
      '    question: "Replacement target question?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: Foundation',
      '      question: "Original winner question?"',
      '    after:',
      '      id: Q01',
      '      phase: Foundation',
      '      question: "Refined winner question?"',
      '  - type: replaced',
      '    before:',
      '      id: Q02',
      '      phase: Structure',
      '      question: "Winner replacement source question?"',
      '    after:',
      '      id: Q03',
      '      phase: Structure',
      '      question: "Replacement target question?"',
      '    inspiration:',
      '      alternative_draft: 1',
      '      question:',
      '        id: Q07',
      '        phase: Structure',
      '        question: "Alternative draft replacement question?"',
    ].join('\n')

    refineDraftMock.mockImplementation(async (...args: unknown[]) => {
      const validateResponse = args[12] as ((content: string) => { normalizedContent?: string }) | undefined
      if (!validateResponse) return { content: rawRefinementOutput, rawAttempts: [] }
      const validation = validateResponse(rawRefinementOutput)
      return { content: validation.normalizedContent ?? rawRefinementOutput, rawAttempts: [] }
    })

    phaseIntermediate.set(`${ticket.id}:interview`, {
      phase: 'interview',
      worktreePath: repoDir,
      winnerId: TEST.councilMembers[0],
      drafts: [
        {
          memberId: TEST.councilMembers[0],
          content: winnerDraftContent,
          outcome: 'completed',
          duration: 1000,
        },
        {
          memberId: TEST.councilMembers[1],
          content: losingDraftContent,
          outcome: 'completed',
          duration: 1000,
        },
      ],
      memberOutcomes: {
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      ticketState: {
        ticketId: ticket.externalId,
        title: ticket.title,
        description: ticket.description ?? '',
        relevantFiles: '',
      },
    })

    const sendEvent = vi.fn()

    await handleInterviewCompile(
      ticket.id,
      makeTicketContext(ticket, {
        status: 'COMPILING_INTERVIEW',
        lockedMainImplementer: TEST.implementer,
        lockedCouncilMembers: [...TEST.councilMembers],
        lockedInterviewQuestions: 10,
        lockedCoverageFollowUpBudgetPercent: 20,
        lockedMaxCoveragePasses: 3,
      }),
      sendEvent,
      new AbortController().signal,
    )

    const uiDiffArtifact = getLatestPhaseArtifact(ticket.id, 'ui_refinement_diff:interview', 'COMPILING_INTERVIEW')
    expect(uiDiffArtifact).toBeDefined()

    const parsedUiDiff = parseUiRefinementDiffArtifact(uiDiffArtifact?.content)
    expect(parsedUiDiff?.domain).toBe('interview')
    expect(parsedUiDiff?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeType: 'replaced',
        beforeId: 'Q02',
        afterId: 'Q03',
        inspiration: expect.objectContaining({
          memberId: TEST.councilMembers[1],
          sourceId: 'Q07',
          sourceText: 'Alternative draft replacement question?',
        }),
        attributionStatus: 'inspired',
      }),
    ]))

    const paths = getTicketPaths(ticket.id)
    expect(paths).toBeDefined()
    const mirroredUiDiff = readFileSync(`${paths!.ticketDir}/ui/refinement-diffs/interview.json`, 'utf-8')
    expect(parseUiRefinementDiffArtifact(mirroredUiDiff)?.entries).toEqual(parsedUiDiff?.entries)

    const compiledArtifact = getLatestPhaseArtifact(ticket.id, 'interview_compiled', 'COMPILING_INTERVIEW')
    expect(compiledArtifact).toBeDefined()
    const compiledPayload = JSON.parse(compiledArtifact!.content) as { refinedContent?: string; changes?: unknown }
    expect(compiledPayload.refinedContent).toContain('Refined winner question?')
    expect(compiledPayload.refinedContent).toContain('Replacement target question?')
    expect('changes' in compiledPayload).toBe(false)
    expect(refineDraftMock.mock.calls[0]?.[15]).toBe('read_only')

    expect(readExecutionLogEntries(ticket.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: `Compiled final interview from winner ${TEST.councilMembers[0]}. Validated 2 normalized questions.`,
        source: 'system',
        modelId: TEST.councilMembers[0],
      }),
    ]))

    expect(sendEvent).toHaveBeenCalledWith({ type: 'READY' })
  })

  it('restores interview inspiration tooltips when the refiner cites a source question as plain text', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Hydrate scalar inspiration question text',
      description: 'Persist tooltip-ready interview inspiration even when the model returns source text without question metadata.',
    })

    initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    const winnerDraftContent = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "Original winner question?"',
    ].join('\n')

    const losingDraftContent = [
      'questions:',
      '  - id: Q07',
      '    phase: Structure',
      '    question: "Alternative draft replacement question?"',
    ].join('\n')

    const rawRefinementOutput = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "Refined winner question?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: Foundation',
      '      question: "Original winner question?"',
      '    after:',
      '      id: Q01',
      '      phase: Foundation',
      '      question: "Refined winner question?"',
      '    inspiration:',
      '      alternative_draft: 1',
      '      question: "Alternative draft replacement question?"',
    ].join('\n')

    refineDraftMock.mockImplementation(async (...args: unknown[]) => {
      const validateResponse = args[12] as ((content: string) => { normalizedContent?: string }) | undefined
      if (!validateResponse) return { content: rawRefinementOutput, rawAttempts: [] }
      const validation = validateResponse(rawRefinementOutput)
      return { content: validation.normalizedContent ?? rawRefinementOutput, rawAttempts: [] }
    })

    phaseIntermediate.set(`${ticket.id}:interview`, {
      phase: 'interview',
      worktreePath: repoDir,
      winnerId: TEST.councilMembers[0],
      drafts: [
        {
          memberId: TEST.councilMembers[0],
          content: winnerDraftContent,
          outcome: 'completed',
          duration: 1000,
        },
        {
          memberId: TEST.councilMembers[1],
          content: losingDraftContent,
          outcome: 'completed',
          duration: 1000,
        },
      ],
      memberOutcomes: {
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      ticketState: {
        ticketId: ticket.externalId,
        title: ticket.title,
        description: ticket.description ?? '',
        relevantFiles: '',
      },
    })

    const sendEvent = vi.fn()

    await handleInterviewCompile(
      ticket.id,
      makeTicketContext(ticket, {
        status: 'COMPILING_INTERVIEW',
        lockedMainImplementer: TEST.implementer,
        lockedCouncilMembers: [...TEST.councilMembers],
        lockedInterviewQuestions: 10,
        lockedCoverageFollowUpBudgetPercent: 20,
        lockedMaxCoveragePasses: 3,
      }),
      sendEvent,
      new AbortController().signal,
    )

    const uiDiffArtifact = getLatestPhaseArtifact(ticket.id, 'ui_refinement_diff:interview', 'COMPILING_INTERVIEW')
    expect(uiDiffArtifact).toBeDefined()

    const parsedUiDiff = parseUiRefinementDiffArtifact(uiDiffArtifact?.content)
    expect(parsedUiDiff?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeType: 'modified',
        beforeId: 'Q01',
        afterId: 'Q01',
        inspiration: expect.objectContaining({
          memberId: TEST.councilMembers[1],
          sourceId: 'Q07',
          sourceText: 'Alternative draft replacement question?',
        }),
        attributionStatus: 'inspired',
      }),
    ]))

    expect(sendEvent).toHaveBeenCalledWith({ type: 'READY' })
  })
})
