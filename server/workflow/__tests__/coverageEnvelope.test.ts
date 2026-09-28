import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jsYaml from 'js-yaml'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TEST, makeInterviewYaml, makePrdYaml } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, insertPhaseArtifact } from '../../storage/tickets'
import { buildPrdRefinedArtifact, validatePrdRefinementOutput } from '../../phases/prd/refined'
import {
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'

const { runOpenCodePromptMock } = vi.hoisted(() => ({
  runOpenCodePromptMock: vi.fn(),
}))

vi.mock('../runOpenCodePrompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runOpenCodePrompt')>()),
  runOpenCodePrompt: runOpenCodePromptMock,
}))

import {
  handleCoverageVerification,
  normalizeBeadsCoverageEnvelope,
  normalizeInterviewCoverageEnvelope,
  normalizePrdCoverageEnvelope,
  performCoverageExtraFix,
  reconcileExhaustedCoverageEnvelope,
} from '../phases/verificationPhase'
import type { CoverageResultEnvelope } from '../../structuredOutput'

const followUp = { id: 'FU1', question: 'Which platforms?' }

function envelope(overrides: Partial<CoverageResultEnvelope> = {}): CoverageResultEnvelope {
  return { status: 'clean', gaps: [], followUpQuestions: [], ...overrides }
}

const repoManager = createTestRepoManager('verification-coverage-extra-fix')
const coverageGap = 'Document the expected behavior when coverage retries are exhausted.'

function buildCoverageRevision(candidateContent: string, gap: string, changed: boolean): string {
  const document = jsYaml.load(candidateContent) as Record<string, unknown>
  const epics = document.epics as Array<Record<string, unknown>>
  const epic = epics[0]!
  const beforeTitle = String(epic.title)
  const afterTitle = changed ? `${beforeTitle} with retry exhaustion behavior` : beforeTitle

  if (changed) {
    epic.title = afterTitle
    document.changes = [{
      type: 'modified',
      item_type: 'epic',
      before: { id: epic.id, title: beforeTitle },
      after: { id: epic.id, title: afterTitle },
      inspiration: null,
    }]
  }

  document.gap_resolutions = [{
    gap,
    action: changed ? 'updated_prd' : 'left_unresolved',
    rationale: changed
      ? 'The epic now records the retry-exhaustion behavior.'
      : 'The current PRD does not define this behavior, so the gap remains open.',
    affected_items: [{ item_type: 'epic', id: epic.id, label: afterTitle }],
  }]

  return jsYaml.dump(document, { lineWidth: 120, noRefs: true }) as string
}

async function setupPrdCoverage(options: { writePrd?: boolean; lockedMainImplementer?: string | null } = {}) {
  const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
  const winnerId = TEST.councilMembers[0]
  const interviewContent = makeInterviewYaml({ ticket_id: ticket.externalId })
  const rawCandidate = makePrdYaml({ ticketId: ticket.externalId })
  let candidate = rawCandidate
  for (let pass = 0; pass < 3; pass += 1) {
    candidate = validatePrdRefinementOutput(candidate, {
      ticketId: ticket.externalId,
      interviewContent,
      winnerDraftContent: candidate,
      missingChangesPolicy: 'accounted_elsewhere',
    }).refinedContent
  }

  writeFileSync(`${paths.ticketDir}/interview.yaml`, interviewContent, 'utf-8')
  if (options.writePrd !== false) {
    writeFileSync(`${paths.ticketDir}/prd.yaml`, candidate, 'utf-8')
  }

  context.lockedMainImplementer = options.lockedMainImplementer === undefined
    ? TEST.implementer
    : options.lockedMainImplementer
  context.lockedMainImplementerVariant = context.lockedMainImplementer ? 'main-variant' : null
  context.lockedCouncilMembers = [winnerId, TEST.councilMembers[1]]
  context.lockedCouncilMemberVariants = { [winnerId]: 'council-variant' }

  insertPhaseArtifact(ticket.id, {
    phase: 'DRAFTING_PRD',
    artifactType: 'prd_full_answers',
    content: JSON.stringify({ drafts: [{ memberId: winnerId, outcome: 'completed', content: interviewContent }] }),
  })
  insertPhaseArtifact(ticket.id, {
    phase: 'REFINING_PRD',
    artifactType: 'prd_winner',
    content: JSON.stringify({ winnerId }),
  })
  insertPhaseArtifact(ticket.id, {
    phase: 'VERIFYING_PRD_COVERAGE',
    artifactType: 'prd_coverage',
    content: JSON.stringify({
      winnerId,
      status: 'gaps',
      gaps: [coverageGap],
      coverageRunNumber: 1,
      maxCoveragePasses: 3,
      finalCandidateVersion: 1,
      attempts: [{
        candidateVersion: 1,
        status: 'gaps',
        summary: 'PRD Candidate v1 still has 1 gap.',
        gaps: [coverageGap],
        auditNotes: '',
        response: '',
        normalizedContent: '',
        structuredOutput: {},
        coverageRunNumber: 1,
        maxCoveragePasses: 3,
        limitReached: false,
        terminationReason: 'gaps',
      }],
      transitions: [],
    }),
  })

  return { ticket, context, paths, winnerId, interviewContent, candidate }
}

describe('interview coverage envelope', () => {
  it('rejects status clean with gaps', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ gaps: ['Nothing covers retries.'] }))
    expect(result.validationError).toContain('reported status clean but also returned gaps')
  })

  it('rejects status clean with follow-up questions', () => {
    // These used to be dropped in silence: the follow-up resolution returns
    // nothing for any status that is not `gaps`.
    const result = normalizeInterviewCoverageEnvelope(envelope({ followUpQuestions: [followUp] }))
    expect(result.validationError).toContain('reported status clean but also returned follow-up questions')
  })

  it('accepts a clean envelope with neither', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope())
    expect(result.validationError).toBeUndefined()
    expect(result.envelope).toEqual({ status: 'clean', gaps: [], followUpQuestions: [] })
  })

  it('keeps follow-up questions on a gaps envelope', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', followUpQuestions: [followUp] }))
    expect(result.validationError).toBeUndefined()
    expect(result.envelope.followUpQuestions).toEqual([followUp])
  })

  it('accepts a gaps envelope with no gap strings, because follow-ups answer them', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', followUpQuestions: [followUp] }))
    expect(result.validationError).toBeUndefined()
  })

  it('trims empty gap strings and says so', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', gaps: ['Real gap.', '  '] }))
    expect(result.envelope.gaps).toEqual(['Real gap.'])
    expect(result.repairWarnings).toContain('Trimmed empty interview coverage gap strings before persisting the normalized result.')
  })

  it('rejects a gaps envelope that names neither a gap nor a follow-up', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps' }))
    expect(result.validationError).toContain('returned neither a gap string nor a follow-up question')
  })
})

describe('coverage envelope reconciliation once the retries are spent', () => {
  // The retry loop used to record the validation error and carry on with
  // `status: clean` intact, so `detectedGaps` stayed false and the run emitted
  // COVERAGE_CLEAN over gaps the model had actually reported.
  it('reads a clean status that lists gaps as a gaps status', () => {
    const result = reconcileExhaustedCoverageEnvelope(envelope({ gaps: ['Nothing covers retries.'] }))
    expect(result?.envelope.status).toBe('gaps')
    expect(result?.envelope.gaps).toEqual(['Nothing covers retries.'])
    expect(result?.repairWarning).toContain('read it as status gaps')
  })

  it('reads a clean status that lists follow-up questions as a gaps status', () => {
    const result = reconcileExhaustedCoverageEnvelope(envelope({ followUpQuestions: [followUp] }))
    expect(result?.envelope.status).toBe('gaps')
    expect(result?.envelope.followUpQuestions).toEqual([followUp])
  })

  it('reads a gaps status naming nothing as clean', () => {
    const result = reconcileExhaustedCoverageEnvelope(envelope({ status: 'gaps' }))
    expect(result?.envelope.status).toBe('clean')
    expect(result?.repairWarning).toContain('read it as status clean')
  })

  it('leaves a self-consistent envelope alone', () => {
    expect(reconcileExhaustedCoverageEnvelope(envelope())).toBeNull()
    expect(reconcileExhaustedCoverageEnvelope(envelope({ status: 'gaps', gaps: ['A gap.'] }))).toBeNull()
  })
})

describe('PRD and beads coverage envelopes keep their existing contract', () => {
  it.each([
    ['PRD', normalizePrdCoverageEnvelope, 'PRD'],
    ['Beads', normalizeBeadsCoverageEnvelope, 'beads'],
  ] as const)('%s drops follow-up questions with a warning', (label, normalize, trimmedLabel) => {
    const result = normalize(envelope({ status: 'gaps', gaps: ['A gap.'], followUpQuestions: [followUp] }))
    expect(result.envelope.followUpQuestions).toEqual([])
    expect(result.repairWarnings).toContain(
      `${label} coverage follow_up_questions were ignored because ${trimmedLabel} coverage is envelope-only.`,
    )
  })

  it.each([
    ['PRD', normalizePrdCoverageEnvelope],
    ['Beads', normalizeBeadsCoverageEnvelope],
  ] as const)('%s rejects status clean with gaps', (label, normalize) => {
    const result = normalize(envelope({ gaps: ['A gap.'] }))
    expect(result.validationError).toBe(
      `${label} coverage reported status clean but also returned gaps. Return status gaps for unresolved coverage and keep gaps empty when status is clean.`,
    )
  })

  it.each([
    ['PRD', normalizePrdCoverageEnvelope],
    ['Beads', normalizeBeadsCoverageEnvelope],
  ] as const)('%s rejects status gaps with no gap strings', (label, normalize) => {
    const result = normalize(envelope({ status: 'gaps' }))
    expect(result.validationError).toBe(
      `${label} coverage reported status gaps but did not return any non-empty gap strings. Return at least one concrete gap string.`,
    )
  })
})

describe('coverage integration recovery paths', () => {
  beforeEach(() => {
    resetTestDb()
    runOpenCodePromptMock.mockReset()
  })

  afterAll(() => {
    repoManager.cleanup()
  })

  it('records a no-change extra fix while keeping unresolved gaps and the current candidate version', async () => {
    const { ticket, context, paths, candidate } = await setupPrdCoverage({ lockedMainImplementer: null })
    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'prd-extra-fix-no-change-revision', projectPath: paths.worktreePath },
        response: buildCoverageRevision(candidate, coverageGap, false),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'prd-extra-fix-no-change-audit', projectPath: paths.worktreePath },
        response: ['status: gaps', 'gaps:', `  - ${coverageGap}`, 'follow_up_questions: []'].join('\n'),
        messages: [],
      })

    await expect(performCoverageExtraFix({
      ticketId: ticket.id,
      context,
      domain: 'prd',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      domain: 'prd',
      status: 'gaps',
      remainingGaps: [coverageGap],
      extraFixNumber: 1,
      changed: false,
      summary: expect.stringContaining('made no artifact changes'),
    })

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(runOpenCodePromptMock.mock.calls.map(([options]) => options.variant)).toEqual([
      'council-variant',
      'council-variant',
    ])
    expect(getLatestPhaseArtifact(ticket.id, 'prd_coverage_revision', 'WAITING_PRD_APPROVAL')).toBeUndefined()
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8').trim()).toBe(candidate.trim())
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'prd_coverage', 'WAITING_PRD_APPROVAL')!.content)).toMatchObject({
      status: 'gaps',
      finalCandidateVersion: 1,
      remainingGaps: [coverageGap],
    })
  })

  it('persists a changed candidate when its follow-up audit still finds gaps and honors locked model variants', async () => {
    const { ticket, context, paths, candidate, winnerId } = await setupPrdCoverage({ lockedMainImplementer: TEST.councilMembers[0] })
    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'prd-extra-fix-still-gaps-revision', projectPath: paths.worktreePath },
        response: buildCoverageRevision(candidate, coverageGap, true),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'prd-extra-fix-still-gaps-audit', projectPath: paths.worktreePath },
        response: ['status: gaps', 'gaps:', `  - ${coverageGap}`, 'follow_up_questions: []'].join('\n'),
        messages: [],
      })

    await expect(performCoverageExtraFix({
      ticketId: ticket.id,
      context,
      domain: 'prd',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      domain: 'prd',
      status: 'gaps',
      remainingGaps: [coverageGap],
      extraFixNumber: 1,
      changed: true,
      summary: expect.stringContaining('revised PRD Candidate v1 into PRD Candidate v2'),
    })

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(runOpenCodePromptMock.mock.calls.map(([options]) => options.variant)).toEqual([
      'main-variant',
      'council-variant',
    ])
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'prd_coverage_revision', 'WAITING_PRD_APPROVAL')!.content)).toMatchObject({
      winnerId,
      candidateVersion: 2,
      source: 'ai_fix_button',
      extraFixNumber: 1,
    })
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')).toContain('with retry exhaustion behavior')
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'prd_coverage', 'WAITING_PRD_APPROVAL')!.content)).toMatchObject({
      status: 'gaps',
      finalCandidateVersion: 2,
      remainingGaps: [coverageGap],
    })
  })

  it('restores a missing PRD from the scoped refined artifact when the latest unscoped artifact is malformed', async () => {
    const { ticket, context, paths, candidate } = await setupPrdCoverage({
      writePrd: false,
      lockedMainImplementer: null,
    })
    const winnerId = TEST.councilMembers[0]
    const interviewContent = makeInterviewYaml({ ticket_id: ticket.externalId })
    const refinement = validatePrdRefinementOutput(candidate, {
      ticketId: ticket.externalId,
      interviewContent,
      winnerDraftContent: candidate,
      missingChangesPolicy: 'accounted_elsewhere',
    })
    const refinedArtifact = buildPrdRefinedArtifact(winnerId, candidate, refinement)
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify(refinedArtifact),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_PRD_APPROVAL',
      artifactType: 'prd_refined',
      content: '{malformed latest refined artifact',
    })
    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'prd-coverage-recovered-candidate-audit', projectPath: paths.worktreePath },
      response: ['status: clean', 'gaps: []', 'follow_up_questions: []'].join('\n'),
      messages: [],
    })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(existsSync(`${paths.ticketDir}/prd.yaml`)).toBe(true)
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8').trim()).toBe(refinedArtifact.refinedContent.trim())
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(runOpenCodePromptMock.mock.calls[0]?.[0]?.variant).toBe('council-variant')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('emits ERROR without persisting coverage when structured output stays malformed after retries', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const winnerId = TEST.councilMembers[0]
    const snapshot = createInterviewSessionSnapshot({
      winnerId,
      compiledQuestions: [{ id: 'Q01', phase: 'Requirements', question: 'Which requirement matters most?' }],
      maxInitialQuestions: 1,
    })
    context.lockedStructuredRetryCount = 2
    insertPhaseArtifact(ticket.id, {
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
      artifactType: INTERVIEW_SESSION_ARTIFACT,
      content: serializeInterviewSessionSnapshot(snapshot),
    })
    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'malformed-coverage-1', projectPath: paths.worktreePath },
        response: 'not valid coverage output',
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'malformed-coverage-2', projectPath: paths.worktreePath },
        response: 'not valid coverage output',
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'malformed-coverage-3', projectPath: paths.worktreePath },
        response: 'not valid coverage output',
        messages: [],
      })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'interview', new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(3)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: expect.stringContaining('after 2 structured retry attempt(s)'),
      codes: ['COVERAGE_FAILED'],
    }))
    expect(getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()
    expect(getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage_input', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()
    expect(getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()
  })
})
