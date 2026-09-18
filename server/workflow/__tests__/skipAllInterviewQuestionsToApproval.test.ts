import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  recordBatchAnswers,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  getLatestPhaseArtifact,
  getTicketPaths,
  readTicketFile,
  upsertLatestPhaseArtifact,
  writeTicketFile,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { skipAllInterviewQuestionsToApproval } from '../runner'
import {
  claimInterviewBatch,
  InterviewBatchChangedError,
  releaseInterviewBatch,
  snapshotFingerprint,
} from '../phases/interviewPhase'
import { listSkipEvents } from '../skipReceipts'
import * as atomicWrite from '../../io/atomicWrite'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-skip-all-',
  files: {
    'README.md': '# LoopTroop Skip All Test\n',
  },
})

async function makeActiveSkipAllTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Skip rollback',
    description: 'Retry Skip All after a partial commit.',
  })
  await initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })

  const base = createInterviewSessionSnapshot({
    winnerId: 'openai/gpt-5-mini',
    compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters?' }],
    maxInitialQuestions: 1,
  })
  const batch = buildPersistedBatch({
    questions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters?' }],
    progress: { current: 1, total: 1 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'One question.',
    batchNumber: 1,
  }, 'prom4', base)
  const activeSnapshot = recordPreparedBatch(base, batch)
  upsertLatestPhaseArtifact(
    ticket.id,
    INTERVIEW_SESSION_ARTIFACT,
    'WAITING_INTERVIEW_ANSWERS',
    serializeInterviewSessionSnapshot(activeSnapshot),
  )
  return { ticket, activeSnapshot }
}

describe('skipAllInterviewQuestionsToApproval', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('writes canonical interview output and synthetic clean coverage artifacts', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip to approval',
      description: 'Restore interview skip-all shortcut.',
    })

    await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
        { id: 'Q03', phase: 'Assembly', question: 'How will retries be tested?' },
        { id: 'Q04', phase: 'Assembly', question: 'What retry budget is acceptable?' },
      ],
      maxInitialQuestions: 4,
    })

    const firstBatch = buildPersistedBatch({
      questions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
      ],
      progress: { current: 2, total: 4 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Collect the foundation first.',
      batchNumber: 1,
    }, 'prom4', base)

    const answered = recordBatchAnswers(
      recordPreparedBatch(base, firstBatch),
      {
        Q01: 'Keep imports idempotent.',
        Q02: '',
      },
    )

    const currentBatch = buildPersistedBatch({
      questions: [
        { id: 'Q03', phase: 'Assembly', question: 'How will retries be tested?' },
      ],
      progress: { current: 3, total: 4 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'One implementation detail remains.',
      batchNumber: 2,
    }, 'prom4', answered)

    const activeSnapshot = recordPreparedBatch(answered, currentBatch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(activeSnapshot),
    )

    const result = skipAllInterviewQuestionsToApproval(ticket.id, {
      Q03: 'Exercise retries against a flaky upstream fake.',
    })

    const paths = getTicketPaths(ticket.id)
    expect(paths).toBeDefined()

    const interviewYaml = readFileSync(paths!.ticketDir + '/interview.yaml', 'utf-8')
    expect(interviewYaml).toBe(result.canonicalInterview)
    expect(interviewYaml).toContain('ticket_id: LOOP-1')
    expect(interviewYaml).toContain('free_text: Keep imports idempotent.')
    expect(interviewYaml).toContain('free_text: Exercise retries against a flaky upstream fake.')
    expect(interviewYaml).toContain('prompt: What retry budget is acceptable?')
    expect(interviewYaml).toContain('skipped: true')

    expect(result.snapshot.currentBatch).toBeNull()
    expect(result.snapshot.completedAt).toBeTruthy()
    expect(result.snapshot.answers.Q04).toMatchObject({
      answer: '',
      skipped: true,
      batchNumber: 2,
    })

    expect(getLatestPhaseArtifact(ticket.id, 'interview_current_batch', 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()

    const coverageInputArtifact = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage_input', 'VERIFYING_INTERVIEW_COVERAGE')
    expect(coverageInputArtifact).toBeDefined()
    const coverageInput = parseUiArtifactCompanionArtifact(coverageInputArtifact!.content)?.payload as { interview?: string; userAnswers?: string } | undefined
    if (!coverageInput) throw new Error('Expected interview coverage-input companion payload')
    expect(coverageInput.interview).toBe(interviewYaml)
    expect(coverageInput.userAnswers).toContain('Q01: What outcome matters most?')
    expect(coverageInput.userAnswers).toContain('Answer: Keep imports idempotent.')
    expect(coverageInput.userAnswers).toContain('Q03: How will retries be tested?')
    expect(coverageInput.userAnswers).toContain('Answer: Exercise retries against a flaky upstream fake.')

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    const coverage = JSON.parse(coverageArtifact!.content) as { winnerId?: string; hasGaps?: boolean; response?: string }
    expect(coverage).toMatchObject({
      winnerId: 'openai/gpt-5-mini',
      hasGaps: false,
    })

    const coverageCompanionArtifact = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')
    expect(coverageCompanionArtifact).toBeDefined()
    const coverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanionArtifact!.content)?.payload as { response?: string } | undefined
    if (!coverageCompanion) throw new Error('Expected interview coverage companion payload')
    expect(coverageCompanion).toMatchObject({
      response: 'Coverage skipped by user shortcut after marking remaining questions skipped.',
    })
  })

  it('does not overwrite a newer session snapshot after claiming skip-all', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip CAS',
      description: 'Do not overwrite a newer interview answer.',
    })
    await initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What matters?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'One question.',
      batchNumber: 1,
    }, 'prom4', base)
    const active = recordPreparedBatch(base, batch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(active),
    )

    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    try {
      const newer = { ...active, updatedAt: '2099-09-17T00:00:00.000Z' }
      upsertLatestPhaseArtifact(
        ticket.id,
        INTERVIEW_SESSION_ARTIFACT,
        'WAITING_INTERVIEW_ANSWERS',
        serializeInterviewSessionSnapshot(newer),
      )

      expect(() => skipAllInterviewQuestionsToApproval(ticket.id, { Q01: '' }, {
        claimToken: claim ?? undefined,
        expectedSnapshotFingerprint: snapshotFingerprint(active),
      })).toThrow(InterviewBatchChangedError)
      expect(getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content)
        .toBe(serializeInterviewSessionSnapshot(newer))
    } finally {
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })

  it('restores the snapshot and canonical file when Skip All canonical writing fails', async () => {
    const { ticket, activeSnapshot } = await makeActiveSkipAllTicket()
    writeTicketFile(ticket.id, 'interview.yaml', 'previous canonical\n')
    const originalSafeWrite = atomicWrite.safeAtomicWriteWithin
    let calls = 0
    const canonicalWrite = vi.spyOn(atomicWrite, 'safeAtomicWriteWithin').mockImplementation((...args) => {
      calls += 1
      if (calls === 1) throw new Error('injected canonical write failure')
      return originalSafeWrite(...args)
    })

    try {
      expect(() => skipAllInterviewQuestionsToApproval(ticket.id, { Q01: '' }))
        .toThrow('injected canonical write failure')
    } finally {
      canonicalWrite.mockRestore()
    }

    expect(getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content)
      .toBe(serializeInterviewSessionSnapshot(activeSnapshot))
    expect(readTicketFile(ticket.id, 'interview.yaml')).toBe('previous canonical\n')
    expect(listSkipEvents(ticket.id)).toHaveLength(0)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()

    const retry = skipAllInterviewQuestionsToApproval(ticket.id, { Q01: '' })
    expect(retry.snapshot.completedAt).toBeTruthy()
  })

  it('rolls back receipts and coverage artifacts when a later Skip All write fails', async () => {
    const { ticket, activeSnapshot } = await makeActiveSkipAllTicket()
    writeTicketFile(ticket.id, 'interview.yaml', 'previous canonical\n')
    const originalSafeWrite = atomicWrite.safeAtomicWriteWithin
    let calls = 0
    const coverageWrite = vi.spyOn(atomicWrite, 'safeAtomicWriteWithin').mockImplementation((...args) => {
      calls += 1
      // Canonical interview.yaml is first; the coverage-input mirror is next.
      if (calls === 2) throw new Error('injected coverage mirror failure')
      return originalSafeWrite(...args)
    })

    try {
      expect(() => skipAllInterviewQuestionsToApproval(ticket.id, { Q01: '' }))
        .toThrow('injected coverage mirror failure')
    } finally {
      coverageWrite.mockRestore()
    }

    expect(getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content)
      .toBe(serializeInterviewSessionSnapshot(activeSnapshot))
    expect(readTicketFile(ticket.id, 'interview.yaml')).toBe('previous canonical\n')
    expect(readTicketFile(ticket.id, 'ui/artifact-companions/interview_coverage_input.json')).toBeNull()
    expect(listSkipEvents(ticket.id)).toHaveLength(0)
    expect(getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage_input', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()
    expect(getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()
    expect(getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')).toBeUndefined()

    const retry = skipAllInterviewQuestionsToApproval(ticket.id, { Q01: '' })
    expect(retry.snapshot.completedAt).toBeTruthy()
  })
})
