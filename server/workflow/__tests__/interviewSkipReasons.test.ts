import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import {
  buildPersistedBatch,
  completeInterviewBySkippingRemaining,
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  recordBatchAnswers,
  recordPreparedBatch,
  resolveSkippedQuestionIdsForSkipAll,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { skipAllInterviewQuestionsToApproval } from '../runner'
import { listSkipEvents } from '../skipReceipts'
import { countSkipEvents } from '@shared/skipReceipt'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-interview-skip-reason-',
  files: {
    'README.md': '# LoopTroop Interview Skip Reason Test\n',
  },
})

const COMPILED_QUESTIONS = [
  { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
  { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
  { id: 'Q03', phase: 'Assembly', question: 'How will retries be tested?' },
  { id: 'Q04', phase: 'Assembly', question: 'What retry budget is acceptable?' },
]

function buildSnapshotWithSecondBatch() {
  const base = createInterviewSessionSnapshot({
    winnerId: 'openai/gpt-5-mini',
    compiledQuestions: COMPILED_QUESTIONS,
    maxInitialQuestions: 4,
  })

  const firstBatch = buildPersistedBatch({
    questions: COMPILED_QUESTIONS.slice(0, 2),
    progress: { current: 2, total: 4 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Foundation first.',
    batchNumber: 1,
  }, 'prom4', base)

  // Q01 answered, Q02 skipped with its own reason, in an earlier batch.
  const answered = recordBatchAnswers(
    recordPreparedBatch(base, firstBatch),
    { Q01: 'Keep imports idempotent.', Q02: '' },
    {},
    { Q02: 'Covered by the architecture decision record.' },
  )

  const secondBatch = buildPersistedBatch({
    questions: COMPILED_QUESTIONS.slice(2, 3),
    progress: { current: 3, total: 4 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'One detail remains.',
    batchNumber: 2,
  }, 'prom4', answered)

  return recordPreparedBatch(answered, secondBatch)
}

function makeStartedTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Interview skip reasons',
    description: 'Reasons travel with the interview.',
  })
  initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })
  return ticket
}

describe('interview skip reasons', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('records a reason against the answer a batch actually skips', () => {
    const snapshot = recordBatchAnswers(
      buildSnapshotWithSecondBatch(),
      { Q03: '' },
      {},
      { Q03: 'The retry story is out of scope for this ticket.' },
    )

    expect(snapshot.answers.Q03).toMatchObject({
      skipped: true,
      skipReason: 'The retry story is out of scope for this ticket.',
    })
    expect(snapshot.answers.Q03?.skippedAt).toBeTruthy()
    expect(snapshot.answers.Q03?.answeredAt).toBeNull()
  })

  it('drops a reason for a question the person answered after all', () => {
    const snapshot = recordBatchAnswers(
      buildSnapshotWithSecondBatch(),
      { Q03: 'Against a flaky upstream fake.' },
      {},
      { Q03: 'A reason that no longer describes anything.' },
    )

    expect(snapshot.answers.Q03).toMatchObject({ skipped: false })
    expect(snapshot.answers.Q03?.skipReason).toBeUndefined()
  })

  it('names exactly the questions a Skip All would leave skipped', () => {
    const snapshot = buildSnapshotWithSecondBatch()

    expect(resolveSkippedQuestionIdsForSkipAll(snapshot, { Q03: '' })).toEqual(new Set(['Q03', 'Q04']))
    expect(resolveSkippedQuestionIdsForSkipAll(snapshot, { Q03: 'Answered now.' })).toEqual(new Set(['Q04']))
  })

  it('lets the bulk reason fill gaps without overwriting anything', () => {
    const finalized = completeInterviewBySkippingRemaining(
      buildSnapshotWithSecondBatch(),
      { Q03: '' },
      {
        skipReasons: { Q03: 'Specific reason for this one.' },
        bulkReason: 'Shipping before the demo.',
      },
    )

    // Per-question reason wins over the bulk reason.
    expect(finalized.answers.Q03?.skipReason).toBe('Specific reason for this one.')
    // A question nobody ever reached gets the bulk reason.
    expect(finalized.answers.Q04?.skipReason).toBe('Shipping before the demo.')
    // An earlier batch is already committed and is not part of this action.
    expect(finalized.answers.Q02?.skipReason).toBe('Covered by the architecture decision record.')
    // An answered question is untouched.
    expect(finalized.answers.Q01).toMatchObject({ skipped: false })
    expect(finalized.answers.Q01?.skipReason).toBeUndefined()
  })

  it('carries reasons into interview.yaml and leaves one action with N items behind', () => {
    const ticket = makeStartedTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(buildSnapshotWithSecondBatch()),
    )

    const result = skipAllInterviewQuestionsToApproval(ticket.id, { Q03: '' }, {
      skipReasons: { Q03: 'Out of scope for this ticket.' },
      bulkReason: 'Shipping before the demo.',
    })

    const interviewYaml = readFileSync(`${getTicketPaths(ticket.id)!.ticketDir}/interview.yaml`, 'utf-8')
    expect(interviewYaml).toBe(result.canonicalInterview)
    expect(interviewYaml).toContain('skip_reason: Out of scope for this ticket.')
    expect(interviewYaml).toContain('skip_reason: Shipping before the demo.')
    expect(interviewYaml).toContain('answered_by: user_skip')
    // The answered question gains no reason key at all.
    expect(interviewYaml.match(/skip_reason:/g)?.length).toBe(3)

    const events = listSkipEvents(ticket.id)
    expect(countSkipEvents(events)).toEqual({
      actions: 1,
      items: 3,
      itemsWithReason: 3,
      itemsWithoutReason: 0,
    })
    expect(events.find((event) => event.isActionSummary)?.reason).toBe('Shipping before the demo.')
    expect(events.find((event) => event.itemId === 'Q03')?.reason).toBe('Out of scope for this ticket.')
  })

  it('records the same Skip All once when it is replayed', () => {
    const ticket = makeStartedTicket()
    const snapshot = buildSnapshotWithSecondBatch()
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(snapshot),
    )

    skipAllInterviewQuestionsToApproval(ticket.id, { Q03: '' }, { bulkReason: 'Shipping before the demo.' })
    const afterFirst = listSkipEvents(ticket.id).length

    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(snapshot),
    )
    skipAllInterviewQuestionsToApproval(ticket.id, { Q03: '' }, { bulkReason: 'Shipping before the demo.' })

    expect(listSkipEvents(ticket.id)).toHaveLength(afterFirst)
  })
})
