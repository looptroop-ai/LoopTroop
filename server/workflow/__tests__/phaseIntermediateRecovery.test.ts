import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertPhaseArtifact, writeTicketFile } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { tryRecoverPhaseIntermediate } from '../phases/helpers'
import { phaseIntermediate } from '../phases/state'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'

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
  it.each(['prd', 'beads'] as const)('refuses %s recovery when its canonical input escapes the ticket', async (pipeline) => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    insertPhaseArtifact(ticket.id, {
      phase: pipeline === 'prd' ? 'DRAFTING_PRD' : 'DRAFTING_BEADS',
      artifactType: `${pipeline}_drafts`,
      content: JSON.stringify({
        isFinal: true, drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'draft' }],
      }),
    })
    const outside = repoManager.createRepo()
    const outsideFile = join(outside, 'README.md')
    const inputPath = join(paths.ticketDir, pipeline === 'prd' ? 'interview.yaml' : 'prd.yaml')
    symlinkSync(outsideFile, inputPath, process.platform === 'win32' ? 'file' : undefined)
    const containmentError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(tryRecoverPhaseIntermediate(ticket.id, context, pipeline, false)).toBe(false)
      expect(containmentError).toHaveBeenCalledWith(expect.stringContaining('Symbolic link escapes root'))
      expect(phaseIntermediate.has(`${ticket.id}:${pipeline}`)).toBe(false)
    } finally {
      containmentError.mockRestore()
    }
  })
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
  })

  afterAll(() => {
    resetTestDb()
  })

  it.each([
    { state: 'missing', content: undefined },
    {
      state: 'still in progress',
      content: JSON.stringify({
        isFinal: false,
        drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'Partial draft.' }],
      }),
    },
  ])('does not recover when the draft artifact is $state', async ({ content }) => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    if (content) {
      insertPhaseArtifact(ticket.id, {
        phase: 'COUNCIL_DELIBERATING',
        artifactType: 'interview_drafts',
        content,
      })
    }

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'interview', false)).toBe(false)
    expect(phaseIntermediate.has(`${ticket.id}:interview`)).toBe(false)
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

  it.each([
    { state: 'missing', artifact: undefined },
    { state: 'unfinished', artifact: JSON.stringify({ isFinal: false, winnerId: WINNER_ID }) },
  ])('refuses recovery when required votes are $state', async ({ artifact }) => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    seedInterviewDrafts(ticket.id)
    if (artifact) seedInterviewVotes(ticket.id, artifact)

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

  it('restores PRD drafts, completed full answers, and the refine context', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    writeTicketFile(ticket.id, 'interview.yaml', 'questions:\n  - id: q1\n    answer: Existing answer\n')
    insertPhaseArtifact(ticket.id, {
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: JSON.stringify({
        isFinal: true,
        drafts: [
          { memberId: WINNER_ID, outcome: 'completed', content: 'Complete requirements answer.' },
          { memberId: LOSER_ID, outcome: 'timed_out', content: 'Incomplete answer.' },
        ],
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_drafts',
      content: JSON.stringify({
        isFinal: true,
        drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'Recovered PRD draft.' }],
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'COUNCIL_VOTING_PRD',
      artifactType: 'prd_votes',
      content: JSON.stringify({ isFinal: true, winnerId: WINNER_ID }),
    })

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'prd', true)).toBe(true)
    const recovered = phaseIntermediate.get(`${ticket.id}:prd`)
    expect(recovered).toMatchObject({
      phase: 'prd_draft',
      worktreePath: paths.worktreePath,
      winnerId: WINNER_ID,
      drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'Recovered PRD draft.', duration: 0 }],
      fullAnswers: [
        { memberId: WINNER_ID, outcome: 'completed', content: 'Complete requirements answer.', duration: 0 },
        { memberId: LOSER_ID, outcome: 'timed_out', content: 'Incomplete answer.', duration: 0 },
      ],
      ticketState: { interview: expect.stringContaining('Existing answer'), fullAnswers: ['Complete requirements answer.'] },
    })
    expect(recovered?.contextBuilder?.('refine')[0]?.content).toContain('Complete requirements answer.')
    expect(recovered?.contextBuilder?.('refine')[0]?.content).not.toContain('Incomplete answer.')
  })

  it('restores Beads drafts and rebuilds their context from the saved PRD', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    writeTicketFile(ticket.id, 'prd.yaml', 'summary: Existing PRD input\n')
    insertPhaseArtifact(ticket.id, {
      phase: 'DRAFTING_BEADS',
      artifactType: 'beads_drafts',
      content: JSON.stringify({
        isFinal: true,
        drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'Recovered Beads draft.' }],
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'COUNCIL_VOTING_BEADS',
      artifactType: 'beads_votes',
      content: JSON.stringify({ isFinal: true, winnerId: WINNER_ID }),
    })

    expect(tryRecoverPhaseIntermediate(ticket.id, context, 'beads', true)).toBe(true)
    const recovered = phaseIntermediate.get(`${ticket.id}:beads`)
    expect(recovered).toMatchObject({
      phase: 'beads_draft',
      worktreePath: paths.worktreePath,
      winnerId: WINNER_ID,
      drafts: [{ memberId: WINNER_ID, outcome: 'completed', content: 'Recovered Beads draft.', duration: 0 }],
    })
    expect(recovered?.ticketState).toBeUndefined()
    expect(recovered?.contextBuilder?.('refine')[0]?.content).toContain('Existing PRD input')
  })
})
