import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertPhaseArtifact } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { tryRecoverPhaseIntermediate } from '../phases/helpers'
import { phaseIntermediate } from '../phases/state'

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

const repoManager = createTestRepoManager('phase-recovery')

const WINNER_ID = TEST.councilMembers[0]!
const LOSER_ID = TEST.councilMembers[1]!

function seedInterviewDrafts(ticketId: string) {
  insertPhaseArtifact(ticketId, {
    phase: 'COUNCIL_DELIBERATING',
    artifactType: 'interview_drafts',
    content: JSON.stringify({
      isFinal: true,
      drafts: [
        { memberId: WINNER_ID, outcome: 'completed', content: 'questions: []' },
        { memberId: LOSER_ID, outcome: 'completed', content: 'questions: []' },
      ],
    }),
  })
}

function seedInterviewVotes(ticketId: string, content: string) {
  insertPhaseArtifact(ticketId, {
    phase: 'COUNCIL_VOTING_INTERVIEW',
    artifactType: 'interview_votes',
    content,
  })
}

describe('tryRecoverPhaseIntermediate validates the persisted winner', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
  })

  afterAll(() => {
    resetTestDb()
  })

  it('recovers a winner that has a completed draft', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    seedInterviewDrafts(ticket.id)
    seedInterviewVotes(ticket.id, JSON.stringify({ isFinal: true, winnerId: WINNER_ID }))

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', true)).toBe(true)
    expect(phaseIntermediate.get(`${ticket.id}:interview`)?.winnerId).toBe(WINNER_ID)
  })

  it('refuses a vote artifact whose winnerId is not a string', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    seedInterviewDrafts(ticket.id)
    seedInterviewVotes(ticket.id, JSON.stringify({ isFinal: true, winnerId: { modelId: WINNER_ID } }))

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', true)).toBe(false)
    expect(phaseIntermediate.has(`${ticket.id}:interview`)).toBe(false)
  })

  it('refuses a winnerId with no matching draft', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    seedInterviewDrafts(ticket.id)
    seedInterviewVotes(ticket.id, JSON.stringify({ isFinal: true, winnerId: 'test-vendor/never-drafted' }))

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', true)).toBe(false)
    expect(phaseIntermediate.has(`${ticket.id}:interview`)).toBe(false)
  })

  it('refuses a winner whose draft did not complete', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    insertPhaseArtifact(ticket.id, {
      phase: 'COUNCIL_DELIBERATING',
      artifactType: 'interview_drafts',
      content: JSON.stringify({
        isFinal: true,
        drafts: [
          { memberId: WINNER_ID, outcome: 'timed_out', content: '' },
          { memberId: LOSER_ID, outcome: 'completed', content: 'questions: []' },
        ],
      }),
    })
    seedInterviewVotes(ticket.id, JSON.stringify({ isFinal: true, winnerId: WINNER_ID }))

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', true)).toBe(false)
  })

  it('refuses a winner whose draft is nothing but whitespace', async () => {
    // `Boolean(draft.content)` was true for `'   '`, so recovery succeeded and
    // refinement then ran against an empty winning draft.
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    insertPhaseArtifact(ticket.id, {
      phase: 'COUNCIL_DELIBERATING',
      artifactType: 'interview_drafts',
      content: JSON.stringify({
        isFinal: true,
        drafts: [
          { memberId: WINNER_ID, outcome: 'completed', content: '   \n  ' },
          { memberId: LOSER_ID, outcome: 'completed', content: 'questions: []' },
        ],
      }),
    })
    seedInterviewVotes(ticket.id, JSON.stringify({ isFinal: true, winnerId: WINNER_ID }))

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', true)).toBe(false)
  })

  it('still recovers drafts when votes are not needed', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    seedInterviewDrafts(ticket.id)

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', false)).toBe(true)
    expect(phaseIntermediate.get(`${ticket.id}:interview`)?.winnerId).toBeUndefined()
  })
})
