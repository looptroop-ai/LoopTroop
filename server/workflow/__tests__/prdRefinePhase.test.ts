import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as jsYaml from 'js-yaml'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { getLatestPhaseArtifact, insertPhaseArtifact } from '../../storage/tickets'
import {
  buildPrdRefinedArtifact,
  parsePrdRefinedArtifact,
  validatePrdRefinementOutput,
} from '../../phases/prd/refined'
import { phaseIntermediate } from '../phases/state'
import {
  TEST,
  makeInterviewYaml,
} from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'

const {
  refineDraftMock,
  runOpenCodePromptMock,
  runOpenCodeSessionPromptMock,
} = vi.hoisted(() => ({
  refineDraftMock: vi.fn(),
  runOpenCodePromptMock: vi.fn(),
  runOpenCodeSessionPromptMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../council/refiner', () => ({
  refineDraft: refineDraftMock,
}))

vi.mock('../runOpenCodePrompt', () => ({
  formatPromptText: (parts: Array<{ type?: string; source?: string; content?: string }>) => {
    if (parts.length === 1 && !parts[0]?.source) return parts[0]?.content ?? ''
    return parts.map((part) => `### ${part.source ?? part.type}\n${part.content ?? ''}`).join('\n\n')
  },
  runOpenCodePrompt: runOpenCodePromptMock,
  runOpenCodeSessionPrompt: runOpenCodeSessionPromptMock,
}))

import { handlePrdRefine } from '../phases/prdPhase'
import { handleCoverageVerification } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('prd-refine')

function buildPrdContent(
  ticketId: string,
  options: {
    epicTitle?: string
    storyOneTitle?: string
    includeStoryTwo?: boolean
    includeStoryThree?: boolean
    storyThreeId?: string
    storyThreeTitle?: string
    storyThreeAcceptanceCriterion?: string
    storyThreeImplementationStep?: string
    changes?: unknown[]
  } = {},
): string {
  const document: Record<string, unknown> = {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'prd',
    status: 'draft',
    source_interview: {
      content_sha256: 'stale-hash',
    },
    product: {
      problem_statement: 'Keep PRD refinement strict and restart-safe.',
      target_users: ['LoopTroop maintainers'],
    },
    scope: {
      in_scope: ['PRD refinement validation', 'artifact parsing'],
      out_of_scope: ['Execution pipeline changes'],
    },
    technical_requirements: {
      architecture_constraints: ['Preserve the winner-only refinement flow.'],
      data_model: [],
      api_contracts: [],
      security_constraints: [],
      performance_constraints: [],
      reliability_constraints: ['Validated artifacts must survive restarts.'],
      error_handling_rules: ['Retry once on structured-output failures.'],
      tooling_assumptions: [],
    },
    epics: [
      {
        id: 'EPIC-1',
        title: options.epicTitle ?? 'Prompt hardening',
        objective: 'Make PRD refinement exact and auditable.',
        implementation_steps: ['Compare the winner draft against the final refined PRD.'],
        user_stories: [
          {
            id: 'US-1',
            title: options.storyOneTitle ?? 'Validate PRD refinement',
            acceptance_criteria: ['Every winner-to-final diff is represented exactly once.'],
            implementation_steps: ['Validate change coverage before persisting the artifact.'],
            verification: {
              required_commands: ['npm run test'],
            },
          },
          ...(options.includeStoryTwo === false
            ? []
            : [{
                id: 'US-2',
                title: 'Record change attribution',
                acceptance_criteria: ['Every adopted improvement records its source.'],
                implementation_steps: ['Persist attribution status alongside each change.'],
                verification: {
                  required_commands: ['npm run test'],
                },
              }]),
          ...(options.includeStoryThree
            ? [{
                id: options.storyThreeId ?? 'US-3',
                title: options.storyThreeTitle ?? 'Surface retry metadata',
                acceptance_criteria: [options.storyThreeAcceptanceCriterion ?? 'Structured retry metadata is preserved for review.'],
                implementation_steps: [options.storyThreeImplementationStep ?? 'Expose retry metadata in the final artifact.'],
                verification: {
                  required_commands: ['npm run test'],
                },
              }]
            : []),
        ],
      },
    ],
    risks: ['Loose parsing could hide real refinement mistakes.'],
    approval: {
      approved_by: '',
      approved_at: '',
    },
  }

  if (options.changes !== undefined) {
    document.changes = options.changes
  }

  return jsYaml.dump(document, { lineWidth: 120, noRefs: true }) as string
}

function buildExpectedPrdEpicText(title: string): string {
  return [
    `Title: ${title}`,
    '',
    'Objective: Make PRD refinement exact and auditable.',
    '',
    'Implementation Steps:',
    '- Compare the winner draft against the final refined PRD.',
  ].join('\n')
}

function buildExpectedPrdStoryText(
  title: string,
  acceptanceCriterion: string,
  implementationStep: string,
): string {
  return [
    `Title: ${title}`,
    '',
    'Acceptance Criteria:',
    `- ${acceptanceCriterion}`,
    '',
    'Implementation Steps:',
    `- ${implementationStep}`,
    '',
    'Verification Commands:',
    '- npm run test',
  ].join('\n')
}

function buildValidRefinementOutput(ticketId: string, options: { omitStoryItemType?: boolean } = {}): string {
  return buildPrdContent(ticketId, {
    epicTitle: 'Prompt hardening and refinement safety',
    storyOneTitle: 'Validate PRD refinement exactly',
    includeStoryTwo: false,
    includeStoryThree: true,
    changes: [
      {
        type: 'modified',
        item_type: 'epic',
        before: { id: 'EPIC-1', title: 'Prompt hardening' },
        after: { id: 'EPIC-1', title: 'Prompt hardening and refinement safety' },
        inspiration: null,
      },
      {
        type: 'modified',
        ...(options.omitStoryItemType ? {} : { item_type: 'user_story' }),
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
        inspiration: null,
      },
      {
        type: 'removed',
        item_type: 'user_story',
        before: { id: 'US-2', title: 'Record change attribution' },
        after: null,
        inspiration: null,
      },
      {
        type: 'added',
        item_type: 'user_story',
        before: null,
        after: { id: 'US-3', title: 'Surface retry metadata' },
        inspiration: {
          alternative_draft: 1,
          item: { id: 'US-8', title: 'Expose retry telemetry' },
        },
      },
    ],
  })
}

function buildValidCoverageRevisionOutput(
  ticketId: string,
  coverageGap: string,
  options: {
    epicTitle?: string
    beforeEpicTitle?: string
    storyOneTitle?: string
    storyThreeTitle?: string
    affectedItemLabel?: string
    rationale?: string
  } = {},
): string {
  const epicTitle = options.epicTitle ?? 'Prompt hardening and approval safety'
  const parsed = jsYaml.load(buildPrdContent(ticketId, {
    epicTitle,
    storyOneTitle: options.storyOneTitle ?? 'Validate PRD refinement and approval exactly',
    includeStoryTwo: false,
    includeStoryThree: true,
    storyThreeTitle: options.storyThreeTitle ?? 'Surface retry metadata',
    changes: [
      {
        type: 'modified',
        item_type: 'epic',
        before: { id: 'EPIC-1', title: options.beforeEpicTitle ?? 'Prompt hardening and refinement safety' },
        after: { id: 'EPIC-1', title: epicTitle },
        inspiration: null,
      },
    ],
  })) as Record<string, unknown>

  parsed.gap_resolutions = [
    {
      gap: coverageGap,
      action: 'updated_prd',
      rationale: options.rationale ?? 'Added explicit approval handling when coverage retries are exhausted.',
      affected_items: [
        {
          item_type: 'epic',
          id: 'EPIC-1',
          label: options.affectedItemLabel ?? epicTitle,
        },
      ],
    },
  ]

  return jsYaml.dump(parsed, { lineWidth: 120, noRefs: true }) as string
}

function readExecutionLogEntries(logPath: string) {
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('handlePrdRefine', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    refineDraftMock.mockReset()
    runOpenCodePromptMock.mockReset()
    runOpenCodeSessionPromptMock.mockReset()
  })

  afterAll(() => {
    repoManager.cleanup()
  })

  it('persists a typed prd_refined artifact and captures retry/repair metadata', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const interviewContent = makeInterviewYaml({ ticket_id: ticket.externalId })
    const winnerDraftContent = buildPrdContent(ticket.externalId)
    const validOutput = buildValidRefinementOutput(ticket.externalId, { omitStoryItemType: true })

    writeFileSync(`${paths.ticketDir}/interview.yaml`, interviewContent, 'utf-8')

    phaseIntermediate.set(`${ticket.id}:prd`, {
      phase: 'prd',
      worktreePath: paths.worktreePath,
      winnerId,
      drafts: [
        { memberId: winnerId, outcome: 'completed', content: winnerDraftContent, duration: 1 },
        {
          memberId: TEST.councilMembers[1],
          outcome: 'completed',
          content: buildPrdContent(ticket.externalId, {
            includeStoryThree: true,
            storyThreeId: 'US-8',
            storyThreeTitle: 'Expose retry telemetry',
            storyThreeAcceptanceCriterion: 'Review expose retry telemetry.',
            storyThreeImplementationStep: 'Implement expose retry telemetry.',
          }),
          duration: 1,
        },
      ],
      fullAnswers: [
        { memberId: winnerId, outcome: 'completed', content: interviewContent, duration: 1, questionCount: 1 },
        { memberId: TEST.councilMembers[1], outcome: 'completed', content: interviewContent, duration: 1, questionCount: 1 },
      ],
      memberOutcomes: {
        [winnerId]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      ticketState: {
        ticketId: ticket.externalId,
        title: context.title,
        description: ticket.description ?? '',
        relevantFiles: 'file_count: 1\nfiles:\n  - path: src/main.ts\n',
      },
    })

    refineDraftMock.mockImplementationOnce(async (
      _adapter: unknown,
      _winnerDraft: unknown,
      _losingDrafts: unknown,
      _contextParts: unknown,
      _projectPath: unknown,
      _timeoutMs: unknown,
      _signal: unknown,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      _sessionOwnership: unknown,
      _buildPrompt: unknown,
      validateResponse?: (content: string) => { normalizedContent?: string },
      _schemaReminder?: string,
      buildRetryPrompt?: (params: {
        baseParts: Array<{ type: 'text'; content: string }>
        validationError: string
        rawResponse: string
      }) => Array<{ type: 'text'; content: string }>,
    ) => {
      // The raw response a rejected attempt would quote back. Validating it is
      // covered in phases/prd/__tests__/refined.test.ts; running it here would
      // count a retry this test is asserting did not happen.
      const invalidOutput = validOutput.replace(/\nchanges:[\s\S]*$/, '')

      const retryPrompt = buildRetryPrompt?.({
        baseParts: [{ type: 'text', content: 'original prompt' }],
        validationError: 'unexpected wrapper',
        rawResponse: invalidOutput,
      }) ?? []
      const retryPromptText = retryPrompt.map((part) => part.content).join('\n')
      expect(retryPromptText).toContain('PRD Refinement Structured Output Retry')
      expect(retryPromptText).not.toContain('Do not use tools.')
      expect(retryPromptText).toContain('Use the normal PRD schema plus a top-level `changes` list.')
      expect(retryPromptText).toContain('fully and exactly account for the diff between the winning PRD and the final refined PRD')
      expect(retryPromptText).toContain('Every changed epic or user story must appear exactly once in `changes`.')
      expect(retryPromptText).not.toContain('PROM10b')
      expect(retryPromptText).not.toContain('extra top-level keys')
      expect(retryPromptText).not.toContain('\nchanges:')

      return {
        content: validateResponse?.(validOutput).normalizedContent ?? validOutput,
        rawAttempts: [],
      }
    })

    await handlePrdRefine(ticket.id, context, sendEvent, new AbortController().signal)

    const refinedArtifact = getLatestPhaseArtifact(ticket.id, 'prd_refined', 'REFINING_PRD')
    expect(refinedArtifact).toBeDefined()
    expect(JSON.parse(refinedArtifact!.content)).toEqual({
      refinedContent: expect.any(String),
    })
    const parsed = parsePrdRefinedArtifact(refinedArtifact!.content)
    expect(parsed.draftMetrics).toEqual({ epicCount: 1, userStoryCount: 2 })
    expect(parsed.changes).toEqual([])
    expect(parsed.winnerDraftContent).toBe('')
    expect(parsed.structuredOutput).toBeUndefined()

    const refinedCompanionArtifact = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_refined', 'REFINING_PRD')
    expect(refinedCompanionArtifact).toBeDefined()
    const refinedCompanion = parseUiArtifactCompanionArtifact(refinedCompanionArtifact!.content)?.payload as {
      winnerDraftContent?: string
      draftMetrics?: { epicCount?: number; userStoryCount?: number }
      structuredOutput?: {
        autoRetryCount?: number
        repairApplied?: boolean
        repairWarnings?: string[]
        validationError?: string
      }
    } | undefined
    expect(refinedCompanion).toBeDefined()
    expect(refinedCompanion?.draftMetrics).toEqual({ epicCount: 1, userStoryCount: 2 })
    expect(refinedCompanion?.winnerDraftContent).toContain('title: Prompt hardening')
    expect(refinedCompanion?.structuredOutput).toMatchObject({
      autoRetryCount: 0,
      repairApplied: true,
    })
    expect(refinedCompanion?.structuredOutput?.validationError).toBeUndefined()
    expect(refinedCompanion?.structuredOutput?.repairWarnings?.join('\n')).toContain('Inferred missing PRD refinement item_type')
    const uiDiffArtifact = getLatestPhaseArtifact(ticket.id, 'ui_refinement_diff:prd', 'REFINING_PRD')
    expect(uiDiffArtifact).toBeDefined()
    expect(JSON.parse(uiDiffArtifact!.content)).toMatchObject({
      domain: 'prd',
      winnerId,
      entries: expect.arrayContaining([
        expect.objectContaining({
          changeType: 'added',
          itemKind: 'user_story',
          afterId: 'US-3',
          inspiration: expect.objectContaining({
            memberId: TEST.councilMembers[1],
            sourceId: 'US-8',
            sourceLabel: 'Expose retry telemetry',
          }),
          attributionStatus: 'inspired',
        }),
      ]),
    })
    expect(JSON.parse(uiDiffArtifact!.content)).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          afterId: 'US-3',
          inspiration: expect.objectContaining({
            blocks: [
              {
                kind: 'epic',
                id: 'EPIC-1',
                label: 'Prompt hardening',
                text: buildExpectedPrdEpicText('Prompt hardening'),
              },
              {
                kind: 'user_story',
                id: 'US-8',
                label: 'Expose retry telemetry',
                text: buildExpectedPrdStoryText(
                  'Expose retry telemetry',
                  'Review expose retry telemetry.',
                  'Implement expose retry telemetry.',
                ),
              },
            ],
          }),
        }),
      ]),
    })

    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8').trim()).toBe(parsed.refinedContent.trim())
    expect(getLatestPhaseArtifact(ticket.id, 'prd_winner', 'REFINING_PRD')).toBeDefined()
    expect(phaseIntermediate.get(`${ticket.id}:prd`)).toBeUndefined()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'REFINED' })
  })

  function setupCoverageTest(options?: { writePrd?: boolean; diskPrdContent?: string; writeFullAnswers?: boolean }) {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager)
    const winnerId = TEST.councilMembers[0]
    const interviewContent = makeInterviewYaml({ ticket_id: ticket.externalId })
    const fullAnswersContent = interviewContent.replace('Implement the feature', 'Winner full answers canonical coverage source')
    const winnerDraftContent = buildPrdContent(ticket.externalId)
    const refinement = validatePrdRefinementOutput(buildValidRefinementOutput(ticket.externalId), {
      ticketId: ticket.externalId,
      interviewContent,
      winnerDraftContent,
      losingDraftMeta: [{ memberId: TEST.councilMembers[1] }],
    })

    writeFileSync(`${paths.ticketDir}/interview.yaml`, interviewContent, 'utf-8')
    if (options?.writePrd !== false) {
      writeFileSync(`${paths.ticketDir}/prd.yaml`, options?.diskPrdContent ?? refinement.refinedContent, 'utf-8')
    }

    if (options?.writeFullAnswers !== false) {
      insertPhaseArtifact(ticket.id, {
        phase: 'DRAFTING_PRD',
        artifactType: 'prd_full_answers',
        content: JSON.stringify({
          drafts: [
            { memberId: winnerId, outcome: 'completed', content: fullAnswersContent },
          ],
        }),
      })
    }
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify(buildPrdRefinedArtifact(
        winnerId,
        refinement.winnerDraftContent,
        refinement,
        {
          repairApplied: refinement.repairApplied,
          repairWarnings: refinement.repairWarnings,
          autoRetryCount: 0,
        },
      )),
    })

    return { ticket, context, paths, winnerId, interviewContent, fullAnswersContent, winnerDraftContent, refinement }
  }

  it('uses prd_winner + prd_refined artifacts during PRD coverage verification', async () => {
    const { ticket, context, paths, refinement, fullAnswersContent } = setupCoverageTest()
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
      response: [
        'status: clean',
        'gaps: []',
        'follow_up_questions: []',
      ].join('\n'),
      messages: [],
    })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    const coverageInput = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage_input', 'VERIFYING_PRD_COVERAGE')
    expect(coverageInput).toBeDefined()
    const parsedCoverageInput = parseUiArtifactCompanionArtifact(coverageInput!.content)?.payload as {
      fullAnswers?: string
      interview?: string
      prd?: string
      refinedContent?: string
      changes?: unknown[]
    } | undefined
    if (!parsedCoverageInput) throw new Error('Expected PRD coverage-input companion payload')
    expect(parsedCoverageInput.fullAnswers?.trim()).toBe(fullAnswersContent.trim())
    expect(parsedCoverageInput.interview).toBeUndefined()
    expect(parsedCoverageInput.prd?.trim()).toBe(refinement.refinedContent.trim())
    expect(parsedCoverageInput.refinedContent?.trim()).toBe(refinement.refinedContent.trim())
    expect(parsedCoverageInput.changes).toBeUndefined()
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('fails PRD coverage clearly when the winner Full Answers artifact is unavailable', async () => {
    const { ticket, context } = setupCoverageTest({ writeFullAnswers: false })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(runOpenCodePromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      codes: ['COVERAGE_FAILED'],
      message: expect.stringContaining("winning model's Full Answers artifact"),
    }))
  })

  it('attaches OpenCode usage-limit diagnostics when PRD coverage exhausts structured retries on empty output', async () => {
    const { ticket, context, paths, winnerId } = setupCoverageTest()
    const sendEvent = vi.fn()
    let callNumber = 0

    runOpenCodePromptMock.mockImplementation(async (options: {
      onSessionCreated?: (session: { id: string; projectPath: string }) => void
      onStreamEvent?: (event: unknown) => void
    }) => {
      callNumber += 1
      const session = { id: `coverage-session-${callNumber}`, projectPath: paths.worktreePath }
      options.onSessionCreated?.(session)
      options.onStreamEvent?.({
        type: 'session_status',
        sessionId: session.id,
        status: 'retry',
        attempt: callNumber,
        message: 'The usage limit has been reached',
      })

      return {
        session,
        response: '',
        messages: [],
        responseMeta: {
          hasAssistantMessage: false,
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
          sessionErrored: false,
        },
        attemptMeta: {
          outcome: 'clean',
          responseAccepted: true,
          discardedResponse: false,
          sessionErrored: false,
          latestAssistantErrored: false,
        },
      }
    })

    const error = await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)
      .then(() => null, (caught) => caught)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(sendEvent).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Coverage output failed validation after 1 structured retry attempt(s): No coverage result content found')
    expect((error as Error).message).not.toContain('The usage limit has been reached')
    expect(error).toMatchObject({
      blockedErrorDiagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'The usage limit has been reached',
        modelId: winnerId,
        sessionId: 'coverage-session-2',
      },
      blockedErrorCodes: ['OPENCODE_PROVIDER_ERROR'],
    })
  })

  it('restores a missing prd.yaml from the refined PRD artifact before PRD coverage runs', async () => {
    const { ticket, context, paths, refinement } = setupCoverageTest({ writePrd: false })
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockImplementationOnce(async ({ parts }: { parts: Array<{ content: string }> }) => {
      const promptText = parts.map((part) => part.content).join('\n')
      expect(promptText).toContain('Prompt hardening and refinement safety')
      expect(promptText).toContain('Validate PRD refinement exactly')
      return {
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      }
    })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    const coverageInput = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage_input', 'VERIFYING_PRD_COVERAGE')
    expect(coverageInput).toBeDefined()
    const parsedCoverageInput = parseUiArtifactCompanionArtifact(coverageInput!.content)?.payload as {
      prd?: string
      refinedContent?: string
    } | undefined
    if (!parsedCoverageInput) throw new Error('Expected PRD coverage-input companion payload')
    expect(parsedCoverageInput.prd?.trim()).toBe(refinement.refinedContent.trim())
    expect(parsedCoverageInput.refinedContent?.trim()).toBe(refinement.refinedContent.trim())
    expect(existsSync(`${paths.ticketDir}/prd.yaml`)).toBe(true)
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('uses the on-disk PRD as the effective PRD coverage input when it differs from the refined artifact', async () => {
    const diskPrdContent = buildPrdContent('placeholder', {
      epicTitle: 'Disk PRD source of truth',
      storyOneTitle: 'Inspect the saved PRD exactly',
    })
    const { ticket, context, paths } = setupCoverageTest({ diskPrdContent })
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockImplementationOnce(async ({ parts }: { parts: Array<{ content: string }> }) => {
      const promptText = parts.map((part) => part.content).join('\n')
      expect(promptText).toContain('Disk PRD source of truth')
      expect(promptText).toContain('Inspect the saved PRD exactly')
      expect(promptText).not.toContain('Prompt hardening and refinement safety')

      return {
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      }
    })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    const coverageInput = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage_input', 'VERIFYING_PRD_COVERAGE')
    expect(coverageInput).toBeDefined()
    const parsedCoverageInput = parseUiArtifactCompanionArtifact(coverageInput!.content)?.payload as {
      prd?: string
      refinedContent?: string
    } | undefined
    if (!parsedCoverageInput) throw new Error('Expected PRD coverage-input companion payload')
    expect(parsedCoverageInput.prd?.trim()).toBe(diskPrdContent.trim())
    expect(parsedCoverageInput.refinedContent?.trim()).toBe(diskPrdContent.trim())
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('retries PRD coverage once when the first semantic result contradicts itself', async () => {
    const { ticket, context, paths } = setupCoverageTest()
    const sendEvent = vi.fn()

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps:',
          '  - "Missing acceptance criteria."',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-2', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('revises the PRD in-place during coverage and re-audits the new candidate', async () => {
    const { ticket, context, paths, winnerId } = setupCoverageTest()
    const sendEvent = vi.fn()
    const coverageGap = 'Missing retry-cap approval behavior.'

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockImplementationOnce(async ({ parts }: { parts: Array<{ content: string }> }) => {
        const promptText = parts.map((part) => part.content).join('\n')
        expect(promptText).toContain('### coverage_gaps')
        expect(promptText).toContain(coverageGap)
        expect(promptText).toContain('Prompt hardening and refinement safety')
        return {
          session: { id: 'coverage-session-2', projectPath: paths.worktreePath },
          response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap),
          messages: [],
        }
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(3)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'prd_coverage', 'VERIFYING_PRD_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'clean',
      finalCandidateVersion: 2,
      hasRemainingGaps: false,
      remainingGaps: [],
    })

    const coverageCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage', 'VERIFYING_PRD_COVERAGE')
    const parsedCoverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanion!.content)?.payload as {
      attempts?: Array<{ candidateVersion?: number; status?: string; gaps?: string[] }>
      transitions?: Array<{ fromVersion?: number; toVersion?: number; gaps?: string[]; fromContent?: string; toContent?: string }>
      finalCandidateVersion?: number
      hasRemainingGaps?: boolean
      remainingGaps?: string[]
    } | undefined
    expect(parsedCoverageCompanion).toMatchObject({
      finalCandidateVersion: 2,
      hasRemainingGaps: false,
      remainingGaps: [],
      attempts: [
        expect.objectContaining({
          candidateVersion: 1,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 2,
          status: 'clean',
          gaps: [],
        }),
      ],
      transitions: [
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          gaps: [coverageGap],
          fromContent: expect.stringContaining('Prompt hardening and refinement safety'),
          toContent: expect.stringContaining('Prompt hardening and approval safety'),
        }),
      ],
    })

    const coverageRevision = getLatestPhaseArtifact(ticket.id, 'prd_coverage_revision', 'VERIFYING_PRD_COVERAGE')
    expect(coverageRevision).toBeDefined()
    expect(JSON.parse(coverageRevision!.content)).toMatchObject({
      winnerId,
      candidateVersion: 2,
      refinedContent: expect.stringContaining('Prompt hardening and approval safety'),
    })

    const coverageRevisionCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage_revision', 'VERIFYING_PRD_COVERAGE')
    const parsedCoverageRevision = parseUiArtifactCompanionArtifact(coverageRevisionCompanion!.content)?.payload as {
      candidateVersion?: number
      refinedContent?: string
      changes?: Array<{
        type?: string
        itemType?: string
        before?: { id?: string; label?: string } | null
        after?: { id?: string; label?: string } | null
        attributionStatus?: string
      }>
      gapResolutions?: Array<{ gap?: string; action?: string }>
      uiRefinementDiff?: {
        domain?: string
        entries?: Array<{ changeType?: string; itemKind?: string }>
      }
    } | undefined
    expect(parsedCoverageRevision).toBeDefined()
    expect(parsedCoverageRevision?.candidateVersion).toBe(2)
    expect(parsedCoverageRevision?.refinedContent).toContain('Prompt hardening and approval safety')
    expect(parsedCoverageRevision?.refinedContent).toContain('Validate PRD refinement and approval exactly')
    expect(parsedCoverageRevision?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'modified',
        itemType: 'epic',
      }),
      expect.objectContaining({
        type: 'modified',
        itemType: 'user_story',
        before: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement exactly' }),
        after: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement and approval exactly' }),
        attributionStatus: 'synthesized_unattributed',
      }),
    ]))
    expect(parsedCoverageRevision?.gapResolutions).toEqual([
      expect.objectContaining({
        gap: coverageGap,
        action: 'updated_prd',
      }),
    ])
    expect(parsedCoverageRevision?.uiRefinementDiff).toMatchObject({
      domain: 'prd',
      entries: expect.arrayContaining([
        expect.objectContaining({
          changeType: 'modified',
          itemKind: 'epic',
        }),
      ]),
    })

    const coverageInput = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage_input', 'VERIFYING_PRD_COVERAGE')
    const parsedCoverageInput = parseUiArtifactCompanionArtifact(coverageInput!.content)?.payload as {
      prd?: string
      refinedContent?: string
      candidateVersion?: number
    } | undefined
    expect(parsedCoverageInput?.candidateVersion).toBe(2)
    expect(parsedCoverageInput?.prd).toContain('Prompt hardening and approval safety')
    expect(parsedCoverageInput?.refinedContent).toContain('Prompt hardening and approval safety')
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')).toContain('Prompt hardening and approval safety')
  })

  it('persists winner-owned PRD coverage SYS logs with model attribution for pass, repair, and retry milestones', async () => {
    const { ticket, context, paths, winnerId } = setupCoverageTest()
    const sendEvent = vi.fn()
    const coverageGap = 'Missing retry-cap approval behavior.'

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-2', projectPath: paths.worktreePath },
        response: buildPrdContent(ticket.externalId, {
          epicTitle: 'Prompt hardening and approval safety',
          storyOneTitle: 'Validate PRD refinement and approval exactly',
          includeStoryTwo: false,
          includeStoryThree: true,
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-3', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          affectedItemLabel: 'Outdated epic label',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-4', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    const entries = readExecutionLogEntries(paths.executionLogPath)
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining(`Coverage verification started using winning model: ${winnerId}`),
        source: 'system',
        modelId: winnerId,
      }),
      expect.objectContaining({
        message: expect.stringContaining('PRD coverage resolution required 1 structured retry attempt(s):'),
        source: 'system',
        modelId: winnerId,
      }),
      expect.objectContaining({
        message: expect.stringContaining('Canonicalized affected_items label for epic EPIC-1 from "Outdated epic label" to "Prompt hardening and approval safety".'),
        source: 'system',
        modelId: winnerId,
      }),
      expect.objectContaining({
        message: `Coverage verification passed (winning model: ${winnerId}) for PRD Candidate v2.`,
        source: 'system',
        modelId: winnerId,
      }),
    ]))
  })

  it('supports fourth PRD coverage revision before a final clean v5 pass', async () => {
    const { ticket, context, paths } = setupCoverageTest()
    const sendEvent = vi.fn()
    const coverageGap = 'Missing final approval coverage guidance.'

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-2', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-4', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, and audit safety',
          beforeEpicTitle: 'Prompt hardening and approval safety',
          affectedItemLabel: 'Prompt hardening, approval, and audit safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-5', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-6', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, audit, and rollback safety',
          beforeEpicTitle: 'Prompt hardening, approval, and audit safety',
          affectedItemLabel: 'Prompt hardening, approval, audit, and rollback safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-7', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-8', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, audit, rollback, and review safety',
          beforeEpicTitle: 'Prompt hardening, approval, audit, and rollback safety',
          affectedItemLabel: 'Prompt hardening, approval, audit, rollback, and review safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-9', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(9)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'prd_coverage', 'VERIFYING_PRD_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'clean',
      coverageRunNumber: 5,
      maxCoveragePasses: 5,
      finalCandidateVersion: 5,
      hasRemainingGaps: false,
      remainingGaps: [],
      terminationReason: 'clean',
    })

    const coverageCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage', 'VERIFYING_PRD_COVERAGE')
    const parsedCoverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanion!.content)?.payload as {
      attempts?: Array<{ candidateVersion?: number; status?: string; gaps?: string[] }>
      transitions?: Array<{ fromVersion?: number; toVersion?: number; gaps?: string[] }>
      finalCandidateVersion?: number
      hasRemainingGaps?: boolean
      remainingGaps?: string[]
    } | undefined
    expect(parsedCoverageCompanion).toMatchObject({
      finalCandidateVersion: 5,
      hasRemainingGaps: false,
      remainingGaps: [],
      attempts: [
        expect.objectContaining({
          candidateVersion: 1,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 2,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 3,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 4,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 5,
          status: 'clean',
          gaps: [],
        }),
      ],
      transitions: [
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 2,
          toVersion: 3,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 3,
          toVersion: 4,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 4,
          toVersion: 5,
          gaps: [coverageGap],
        }),
      ],
    })

    const coverageRevision = getLatestPhaseArtifact(ticket.id, 'prd_coverage_revision', 'VERIFYING_PRD_COVERAGE')
    expect(coverageRevision).toBeDefined()
    expect(JSON.parse(coverageRevision!.content)).toMatchObject({
      winnerId: TEST.councilMembers[0],
      candidateVersion: 5,
      refinedContent: expect.stringContaining('Prompt hardening, approval, audit, rollback, and review safety'),
    })

    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')).toContain('Prompt hardening, approval, audit, rollback, and review safety')
    expect(readExecutionLogEntries(paths.executionLogPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: `Coverage verification passed (winning model: ${TEST.councilMembers[0]}) for PRD Candidate v5.`,
        source: 'system',
        modelId: TEST.councilMembers[0],
      }),
    ]))
  })

  it('routes unresolved PRD v5 coverage gaps to approval when the configured retry cap is reached', async () => {
    const { ticket, context, paths } = setupCoverageTest()
    const sendEvent = vi.fn()
    const coverageGap = 'Missing out-of-scope guidance.'

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-2', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-4', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, and audit safety',
          beforeEpicTitle: 'Prompt hardening and approval safety',
          affectedItemLabel: 'Prompt hardening, approval, and audit safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-5', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-6', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, audit, and rollback safety',
          beforeEpicTitle: 'Prompt hardening, approval, and audit safety',
          affectedItemLabel: 'Prompt hardening, approval, audit, and rollback safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-7', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-8', projectPath: paths.worktreePath },
        response: buildValidCoverageRevisionOutput(ticket.externalId, coverageGap, {
          epicTitle: 'Prompt hardening, approval, audit, rollback, and review safety',
          beforeEpicTitle: 'Prompt hardening, approval, audit, and rollback safety',
          affectedItemLabel: 'Prompt hardening, approval, audit, rollback, and review safety',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'coverage-session-9', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(9)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_LIMIT_REACHED' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'GAPS_FOUND' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'prd_coverage', 'VERIFYING_PRD_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'gaps',
      coverageRunNumber: 5,
      maxCoveragePasses: 5,
      finalCandidateVersion: 5,
      limitReached: true,
      hasRemainingGaps: true,
      remainingGaps: [coverageGap],
      terminationReason: 'coverage_pass_limit_reached',
    })

    const coverageCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_coverage', 'VERIFYING_PRD_COVERAGE')
    const parsedCoverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanion!.content)?.payload as {
      attempts?: Array<{ candidateVersion?: number; status?: string; gaps?: string[] }>
      transitions?: Array<{ fromVersion?: number; toVersion?: number; gaps?: string[] }>
      finalCandidateVersion?: number
      hasRemainingGaps?: boolean
      remainingGaps?: string[]
    } | undefined
    expect(parsedCoverageCompanion).toMatchObject({
      finalCandidateVersion: 5,
      hasRemainingGaps: true,
      remainingGaps: [coverageGap],
      attempts: [
        expect.objectContaining({
          candidateVersion: 1,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 2,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 3,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 4,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 5,
          status: 'gaps',
          gaps: [coverageGap],
        }),
      ],
      transitions: [
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 2,
          toVersion: 3,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 3,
          toVersion: 4,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 4,
          toVersion: 5,
          gaps: [coverageGap],
        }),
      ],
    })

    const coverageRevision = getLatestPhaseArtifact(ticket.id, 'prd_coverage_revision', 'VERIFYING_PRD_COVERAGE')
    expect(coverageRevision).toBeDefined()
    expect(JSON.parse(coverageRevision!.content)).toMatchObject({
      candidateVersion: 5,
      refinedContent: expect.stringContaining('Prompt hardening, approval, audit, rollback, and review safety'),
    })

    expect(readExecutionLogEntries(paths.executionLogPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining(`Coverage gaps detected by winning model ${TEST.councilMembers[0]}, but retry cap reached. Routing to approval with unresolved gaps for manual review.`),
        source: 'system',
        modelId: TEST.councilMembers[0],
      }),
    ]))
  })
})
