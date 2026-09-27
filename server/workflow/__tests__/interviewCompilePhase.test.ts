import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_QA_SESSION_ARTIFACT,
  recordBatchAnswers,
  recordPreparedBatch,
} from '../../phases/interview/sessionState'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { parseUiRefinementDiffArtifact } from '@shared/refinementDiffArtifacts'
import type { DraftPhaseResult, DraftProgressEvent } from '../../council/types'
import { attachProject } from '../../storage/projects'
import { createTicket, getLatestPhaseArtifact, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { TEST, makeTicketContextFromTicket as makeTicketContext } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { initializeTicket } from '../../ticket/initialize'
import { MockOpenCodeAdapter } from '../../opencode/adapter'
import { getOpenCodeAdapter } from '../../opencode/factory'
import { interviewQASessions, phaseIntermediate } from '../phases/state'

const { deliberateInterviewMock, refineDraftMock, openCodeAdapterMock } = vi.hoisted(() => ({
  deliberateInterviewMock: vi.fn(),
  refineDraftMock: vi.fn(),
  openCodeAdapterMock: {
    checkHealth: async () => ({ available: true, version: 'test' }),
  },
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => openCodeAdapterMock,
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../phases/interview/deliberate', () => ({
  deliberateInterview: deliberateInterviewMock,
}))

vi.mock('../../council/refiner', () => ({
  refineDraft: refineDraftMock,
}))

import {
  buildCoverageFollowUpCommentary,
  buildInterviewRefinePrompt,
  buildInterviewVotePrompt,
  buildMockInterviewCompiledContent,
  buildMockInterviewDraftContent,
  buildMockInterviewDrafts,
  buildMockInterviewFollowUpQuestions,
  buildMockInterviewFinalQuestion,
  buildMockInterviewQuestions,
  buildMockInterviewVoteResult,
  buildPersistedMockInterviewBatch,
  handleInterviewCompile,
  handleInterviewDeliberate,
  handleInterviewQAStart,
  handleMockCouncilDeliberate,
  handleMockInterviewCompile,
  handleMockInterviewQAStart,
  handleMockInterviewVote,
  loadCanonicalInterview,
  readInterviewQASessionArtifact,
  readInterviewSessionSnapshotArtifact,
  readMockInterviewWinnerId,
  restoreInterruptedInterviewBatch,
  snapshotFingerprint,
  writeCanonicalInterview,
  writeInterviewSessionSnapshotArtifact,
} from '../phases/interviewPhase'
import { broadcaster } from '../../sse/broadcaster'

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

function installOpenCodeAdapterMethods(mockAdapter: MockOpenCodeAdapter): () => void {
  const targetAdapter = getOpenCodeAdapter()
  const methodNames = [
    'createSession',
    'promptSession',
    'getSession',
    'listSessions',
    'getSessionMessages',
    'subscribeToEvents',
    'listPendingQuestions',
    'replyQuestion',
    'rejectQuestion',
    'abortSession',
    'assembleBeadContext',
    'assembleCouncilContext',
  ] as const
  const previous = new Map<string, PropertyDescriptor | undefined>()

  for (const methodName of methodNames) {
    previous.set(methodName, Object.getOwnPropertyDescriptor(targetAdapter, methodName))
    Object.defineProperty(targetAdapter, methodName, {
      configurable: true,
      writable: true,
      value: mockAdapter[methodName].bind(mockAdapter),
    })
  }

  return () => {
    for (const [methodName, descriptor] of previous) {
      if (descriptor) Object.defineProperty(targetAdapter, methodName, descriptor)
      else delete (targetAdapter as unknown as Record<string, unknown>)[methodName]
    }
  }
}

describe('interview workflow phases', () => {
  it('keeps external IDs as interview content and rejects escaped canonical artifact aliases', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager)
    const snapshot = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0], compiledQuestions: [], maxInitialQuestions: 2,
    })
    expect(loadCanonicalInterview(paths.ticketDir)).toBeUndefined()
    const path = writeCanonicalInterview(ticket.externalId, paths.ticketDir, snapshot)
    expect(loadCanonicalInterview(paths.ticketDir)).toContain(ticket.externalId)
    rmSync(path)
    const outside = repoManager.createRepo()
    symlinkSync(outside, join(paths.ticketDir, 'interview.yaml'), 'junction')
    expect(() => loadCanonicalInterview(paths.ticketDir)).toThrow('escapes root')
    expect(() => writeCanonicalInterview(ticket.externalId, paths.ticketDir, snapshot)).toThrow('must not be a symbolic link')
  })
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    interviewQASessions.clear()
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

    await initializeTicket({
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

    await initializeTicket({
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

  it('builds mock interview batches and preserves the voting and refinement prompt context', () => {
    const questions = buildMockInterviewQuestions()
    expect(questions.map(({ id }) => id)).toEqual(['goal', 'constraints', 'verification'])
    expect(buildMockInterviewFollowUpQuestions()[0]?.id).toBe('tradeoffs')
    expect(buildMockInterviewFinalQuestion().id).toBe('final_notes')
    expect(buildMockInterviewCompiledContent()).toContain('What is the primary outcome')
    expect(buildMockInterviewDraftContent(0)).not.toContain('tradeoffs-2')
    expect(buildMockInterviewDraftContent(1)).toContain('tradeoffs-2')

    const members = TEST.councilMembers.map((modelId) => ({
      modelId,
      name: modelId.split('/').at(-1) ?? modelId,
    }))
    const drafts = buildMockInterviewDrafts(members)
    expect(drafts.map(({ questionCount }) => questionCount)).toEqual([3, 4])
    const voteResult = buildMockInterviewVoteResult(members, drafts)
    expect(voteResult).toMatchObject({
      winnerId: TEST.councilMembers[0],
      totalScore: 185,
      presentationOrders: {
        [TEST.councilMembers[0]]: { order: [TEST.councilMembers[0], TEST.councilMembers[1]] },
        [TEST.councilMembers[1]]: { order: [TEST.councilMembers[1], TEST.councilMembers[0]] },
      },
    })

    const ticketState = {
      ticketId: TEST.externalId,
      title: 'Test voting prompt',
      description: 'Keep interview context.',
      relevantFiles: 'src/main.ts',
    }
    const votePrompt = buildInterviewVotePrompt(ticketState, ['Draft A'], [
      { category: 'Coverage', weight: 3, description: 'Checks requirement coverage.' },
    ])
    const refinePrompt = buildInterviewRefinePrompt(ticketState, drafts[0]!, drafts.slice(1))
    expect(votePrompt[0]?.content).toContain('Coverage (3pts)')
    expect(refinePrompt[0]?.content).toContain('Alternative Draft 1')
    expect(buildCoverageFollowUpCommentary('\n  \nA missing acceptance criterion.\n')).toBe(
      'Coverage follow-up needed: A missing acceptance criterion.',
    )
    expect(buildCoverageFollowUpCommentary(' \n ')).toBe(
      'Coverage follow-up questions generated to close remaining gaps.',
    )

    let snapshot = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0],
      compiledQuestions: questions.map(({ id, phase, question }) => ({ id, phase, question })),
      maxInitialQuestions: questions.length,
    })
    expect(buildPersistedMockInterviewBatch(snapshot)).toBeNull()
    const initialBatch = buildPersistedBatch({
      questions: questions.map(({ id, phase, question, priority, rationale }) => ({ id, phase, question, priority, rationale })),
      progress: { current: 1, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Start.',
      batchNumber: 1,
    }, 'prom4', snapshot)
    snapshot = recordBatchAnswers(
      recordPreparedBatch(snapshot, initialBatch),
      Object.fromEntries(questions.map(({ id }) => [id, 'answered'])),
    )

    const followUp = buildPersistedMockInterviewBatch(snapshot)
    expect(followUp).toMatchObject({ batchNumber: 2, isFinalFreeForm: false })
    snapshot = recordBatchAnswers(
      recordPreparedBatch(snapshot, buildPersistedBatch(followUp!, 'prom4', snapshot)),
      { tradeoffs: 'Keep the public interface small.' },
    )
    const finalQuestion = buildPersistedMockInterviewBatch(snapshot)
    expect(finalQuestion).toMatchObject({ batchNumber: 3, isFinalFreeForm: true })
    snapshot = recordBatchAnswers(
      recordPreparedBatch(snapshot, buildPersistedBatch(finalQuestion!, 'prom4', snapshot)),
      { final_notes: 'Preserve deterministic output.' },
    )
    expect(buildPersistedMockInterviewBatch(snapshot)).toBeNull()
  })

  it('writes mock interview draft artifacts and announces the council candidates', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const context = makeTicketContext(ticket, { status: 'COUNCIL_DELIBERATING' })
    const sendEvent = vi.fn()

    await handleMockCouncilDeliberate(ticket.id, context, sendEvent)

    const artifact = getLatestPhaseArtifact(ticket.id, 'interview_drafts', 'COUNCIL_DELIBERATING')
    const persisted = JSON.parse(artifact?.content ?? '{}') as {
      drafts: Array<{ memberId: string; outcome: string }>
      isFinal: boolean
    }
    expect(persisted.drafts.map(({ memberId }) => memberId)).toEqual([...TEST.councilMembers])
    expect(persisted.drafts[0]).toMatchObject({ memberId: TEST.councilMembers[0], outcome: 'completed' })
    expect(persisted.isFinal).toBe(true)
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'QUESTIONS_READY',
      result: { winnerId: TEST.councilMembers[0] },
    })
  })

  it('writes the mock interview winner and emits the voting decision', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const context = makeTicketContext(ticket, { status: 'COUNCIL_VOTING_INTERVIEW' })
    const sendEvent = vi.fn()

    await handleMockInterviewVote(ticket.id, context, sendEvent)

    const artifact = getLatestPhaseArtifact(ticket.id, 'interview_votes', 'COUNCIL_VOTING_INTERVIEW')
    expect(JSON.parse(artifact?.content ?? '{}')).toEqual({
      winnerId: TEST.councilMembers[0],
      isFinal: true,
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: TEST.councilMembers[0] })
  })

  it('compiles a mock interview from the persisted winner and supports the fallback', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const context = makeTicketContext(ticket, { status: 'COMPILING_INTERVIEW' })
    const sendEvent = vi.fn()

    expect(readMockInterviewWinnerId(ticket.id, 'fallback-model')).toBe('fallback-model')
    upsertLatestPhaseArtifact(
      ticket.id,
      'interview_votes',
      'COUNCIL_VOTING_INTERVIEW',
      JSON.stringify({ winnerId: TEST.councilMembers[1] }),
    )
    expect(readMockInterviewWinnerId(ticket.id, 'fallback-model')).toBe(TEST.councilMembers[1])

    await handleMockInterviewCompile(ticket.id, context, sendEvent)

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'interview_winner', 'COMPILING_INTERVIEW')?.content ?? '{}'))
      .toEqual({ winnerId: TEST.councilMembers[1] })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'interview_compiled', 'COMPILING_INTERVIEW')?.content ?? '{}'))
      .toMatchObject({ refinedContent: expect.stringContaining('What is the primary outcome') })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'READY' })
  })

  it('starts and persists a mock interview batch', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const context = makeTicketContext(ticket, {
      status: 'WAITING_INTERVIEW_ANSWERS',
      lockedInterviewQuestions: 10,
      lockedCoverageFollowUpBudgetPercent: 20,
      lockedMaxCoveragePasses: 3,
    })

    await handleMockInterviewQAStart(ticket.id, context)

    expect(readInterviewQASessionArtifact(ticket.id)).toEqual({
      sessionId: 'mock-session',
      winnerId: TEST.councilMembers[0],
    })
    expect(readInterviewSessionSnapshotArtifact(ticket.id)?.currentBatch).toMatchObject({
      batchNumber: 1,
      questions: [{ id: 'goal' }, { id: 'constraints' }, { id: 'verification' }],
    })
  })

  it('resumes a persisted interview batch without starting a model session', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const base = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0],
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Answer this question.',
      batchNumber: 1,
    }, 'prom4', base)
    const snapshot = recordPreparedBatch(base, batch)
    writeInterviewSessionSnapshotArtifact(ticket.id, snapshot)
    const broadcast = vi.spyOn(broadcaster, 'broadcast')

    try {
      await handleInterviewQAStart(
        ticket.id,
        makeTicketContext(ticket, { status: 'WAITING_INTERVIEW_ANSWERS' }),
        vi.fn(),
        new AbortController().signal,
      )
      expect(broadcast).toHaveBeenCalledWith(ticket.id, 'needs_input', {
        ticketId: ticket.id,
        type: 'interview_batch',
        batch: snapshot.currentBatch,
      })
    } finally {
      broadcast.mockRestore()
    }
  })

  it('reports a missing winner when PROM4 is requested before voting finishes', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    await handleInterviewQAStart(
      ticket.id,
      makeTicketContext(ticket, { status: 'WAITING_INTERVIEW_ANSWERS' }),
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'ERROR',
      message: 'No interview winner found — cannot start PROM4 session',
      codes: ['PROM4_NO_WINNER'],
    })
  })

  it('reports an invalid compiled interview instead of opening PROM4', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    upsertLatestPhaseArtifact(
      ticket.id,
      'interview_winner',
      'COMPILING_INTERVIEW',
      JSON.stringify({ winnerId: TEST.councilMembers[0] }),
    )
    upsertLatestPhaseArtifact(ticket.id, 'interview_compiled', 'COMPILING_INTERVIEW', '{')
    const sendEvent = vi.fn()

    await handleInterviewQAStart(
      ticket.id,
      makeTicketContext(ticket, { status: 'WAITING_INTERVIEW_ANSWERS' }),
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      codes: ['PROM4_INVALID_COMPILED_INTERVIEW'],
      message: expect.stringContaining('Compiled interview artifact invalid'),
    }))
  })

  it('rehydrates a persisted PROM4 session after the in-memory cache is empty', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const session = { sessionId: 'persisted-prom4-session', winnerId: TEST.councilMembers[0] }
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_QA_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      JSON.stringify(session),
    )
    interviewQASessions.clear()

    await handleInterviewQAStart(
      ticket.id,
      makeTicketContext(ticket, { status: 'WAITING_INTERVIEW_ANSWERS' }),
      vi.fn(),
      new AbortController().signal,
    )

    expect(interviewQASessions.get(ticket.id)).toEqual(session)
  })

  it('starts PROM4 from the validated compiled interview and persists the first batch', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const winnerId = TEST.councilMembers[0]
    upsertLatestPhaseArtifact(
      ticket.id,
      'interview_winner',
      'COMPILING_INTERVIEW',
      JSON.stringify({ winnerId }),
    )
    upsertLatestPhaseArtifact(
      ticket.id,
      'interview_compiled',
      'COMPILING_INTERVIEW',
      JSON.stringify({ refinedContent: buildInterviewDraftContent('Which outcome matters most?') }),
    )
    const mockAdapter = new MockOpenCodeAdapter()
    mockAdapter.mockResponses.set('mock-session-1', [
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 1',
      'is_final_free_form: false',
      'ai_commentary: Start with the primary outcome.',
      'questions:',
      '  - id: Q01',
      '    question: Which outcome matters most?',
      '    phase: Foundation',
      '    priority: high',
      '    rationale: Confirm the central goal.',
      '    answer_type: free_text',
      '</INTERVIEW_BATCH>',
    ].join('\n'))
    const restoreAdapter = installOpenCodeAdapterMethods(mockAdapter)
    const broadcast = vi.spyOn(broadcaster, 'broadcast')

    try {
      await handleInterviewQAStart(
        ticket.id,
        makeTicketContext(ticket, {
          status: 'WAITING_INTERVIEW_ANSWERS',
          lockedInterviewQuestions: 1,
        }),
        vi.fn(),
        new AbortController().signal,
      )

      expect(readInterviewQASessionArtifact(ticket.id)).toEqual({ sessionId: 'mock-session-1', winnerId })
      expect(readInterviewSessionSnapshotArtifact(ticket.id)?.currentBatch).toMatchObject({
        batchNumber: 1,
        source: 'prom4',
        questions: [{ id: 'Q01', question: 'Which outcome matters most?' }],
      })
      expect(broadcast).toHaveBeenCalledWith(ticket.id, 'needs_input', expect.objectContaining({
        type: 'interview_batch',
        batch: expect.objectContaining({ batchNumber: 1 }),
      }))
    } finally {
      broadcast.mockRestore()
      restoreAdapter()
    }
  })

  it('restores an interrupted PROM4 batch only while its answered snapshot still matches', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const base = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0],
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Answer this question.',
      batchNumber: 1,
    }, 'prom4', base)
    const originalSnapshot = recordPreparedBatch(base, batch)
    const answeredSnapshot = recordBatchAnswers(originalSnapshot, { Q01: 'The required outcome.' })
    const markerType = 'interview_batch_in_flight'
    const marker = {
      originalSnapshot,
      answeredSnapshotFingerprint: snapshotFingerprint(answeredSnapshot),
    }

    writeInterviewSessionSnapshotArtifact(ticket.id, answeredSnapshot)
    upsertLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS', JSON.stringify(marker))
    expect(restoreInterruptedInterviewBatch(ticket.id)).toBe(true)
    expect(readInterviewSessionSnapshotArtifact(ticket.id)?.currentBatch).toMatchObject({ batchNumber: 1 })
    expect(getLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()

    const editedSnapshot = {
      ...answeredSnapshot,
      updatedAt: '2099-09-17T00:00:00.000Z',
      answers: { ...answeredSnapshot.answers, Q01: { ...answeredSnapshot.answers.Q01!, answer: 'Edited after interruption.' } },
    }
    writeInterviewSessionSnapshotArtifact(ticket.id, editedSnapshot)
    upsertLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS', JSON.stringify(marker))
    expect(restoreInterruptedInterviewBatch(ticket.id)).toBe(false)
    expect(readInterviewSessionSnapshotArtifact(ticket.id)?.answers.Q01?.answer).toBe('Edited after interruption.')
    expect(getLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()
  })

  it('discards interrupted-batch markers when their saved state is missing or already has a batch', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const markerType = 'interview_batch_in_flight'
    const base = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0],
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      maxInitialQuestions: 1,
    })
    const currentBatch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters most?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Answer this question.',
      batchNumber: 1,
    }, 'prom4', base)
    const originalSnapshot = recordPreparedBatch(base, currentBatch)
    const marker = {
      originalSnapshot,
      answeredSnapshotFingerprint: snapshotFingerprint(recordBatchAnswers(originalSnapshot, { Q01: 'An answer.' })),
    }

    upsertLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS', JSON.stringify(marker))
    expect(restoreInterruptedInterviewBatch(ticket.id)).toBe(false)
    expect(getLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()

    writeInterviewSessionSnapshotArtifact(ticket.id, originalSnapshot)
    upsertLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS', JSON.stringify(marker))
    expect(restoreInterruptedInterviewBatch(ticket.id)).toBe(false)
    expect(readInterviewSessionSnapshotArtifact(ticket.id)?.currentBatch?.batchNumber).toBe(1)
    expect(getLatestPhaseArtifact(ticket.id, markerType, 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()
  })

  it('rejects malformed interview QA session artifacts', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    upsertLatestPhaseArtifact(ticket.id, INTERVIEW_QA_SESSION_ARTIFACT, 'WAITING_INTERVIEW_ANSWERS', '{')
    expect(readInterviewQASessionArtifact(ticket.id)).toBeNull()

    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_QA_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      JSON.stringify({ sessionId: 123, winnerId: TEST.councilMembers[0] }),
    )
    expect(readInterviewQASessionArtifact(ticket.id)).toBeNull()
  })
})
