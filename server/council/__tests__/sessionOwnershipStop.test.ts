import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeAdapter } from '../../opencode/adapter'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { writeTicketFile } from '../../storage/tickets'
import { generateDrafts } from '../drafter'
import { conductVoting } from '../voter'

vi.mock('../../workflow/runOpenCodePrompt', () => ({
  runOpenCodePrompt: vi.fn(async () => {
    throw new Error('CouncilPhaseDeadlineReached')
  }),
}))

const repoManager = createTestRepoManager('council-session-ownership-')
const adapter = {} as OpenCodeAdapter
const member = { modelId: 'model-a', name: 'Model A' }

async function makeUnrecoverableOwnershipTicket() {
  const { ticket, paths } = await createInitializedTestTicket(repoManager, {
    title: 'Unrecoverable council ownership',
  })
  // A settled local prompt is not proof that a remote create did not publish.
  // An unreadable ownership marker must keep both council cleanup paths
  // unresolved until a later sweep can inspect it.
  writeTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json', '{not-json')
  return { ticket, paths }
}

async function makeSiblingOwnershipTicket(phase: string) {
  const { ticket, paths } = await createInitializedTestTicket(repoManager, {
    title: 'Sibling council ownership',
  })
  writeTicketFile(ticket.id, 'runtime/opencode-pending-sessions.json', JSON.stringify([{
    sessionId: 'sibling-session',
    phase,
    phaseAttempt: 1,
    memberId: 'model-b',
    beadId: null,
    iteration: null,
    step: null,
  }]))
  return { ticket, paths }
}

describe('council session ownership cleanup', () => {
  beforeEach(() => {
    resetTestDb()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('does not claim a settled drafter stopped while ownership is unreadable', async () => {
    const { ticket, paths } = await makeUnrecoverableOwnershipTicket()

    await expect(generateDrafts(
      adapter,
      [member],
      [{ type: 'text', content: 'Draft interview questions.' }],
      paths.worktreePath,
      300_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketId: ticket.id,
        phase: 'COUNCIL_DELIBERATING',
      },
    )).rejects.toThrow('Could not confirm abort of an OpenCode session that was still being created')
  })

  it('does not claim a settled voter stopped while ownership is unreadable', async () => {
    const { ticket, paths } = await makeUnrecoverableOwnershipTicket()

    await expect(conductVoting(
      adapter,
      [member],
      [{ memberId: 'model-b', content: 'Draft.', outcome: 'completed', duration: 1 }],
      [{ type: 'text', content: 'Vote on the draft.' }],
      paths.worktreePath,
      'interview_draft',
      300_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketId: ticket.id,
        phase: 'COUNCIL_VOTING_INTERVIEW',
      },
    )).rejects.toThrow('Could not confirm abort of an OpenCode session that was still being created')
  })

  it('does not treat a sibling drafter as this member\'s unresolved session', async () => {
    const { ticket, paths } = await makeSiblingOwnershipTicket('COUNCIL_DELIBERATING')

    await expect(generateDrafts(
      adapter,
      [member],
      [{ type: 'text', content: 'Draft interview questions.' }],
      paths.worktreePath,
      300_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketId: ticket.id,
        phase: 'COUNCIL_DELIBERATING',
      },
    )).resolves.toMatchObject({
      deadlineReached: false,
      memberOutcomes: { 'model-a': 'failed' },
    })
  })

  it('does not treat a sibling voter as this member\'s unresolved session', async () => {
    const { ticket, paths } = await makeSiblingOwnershipTicket('COUNCIL_VOTING_INTERVIEW')

    await expect(conductVoting(
      adapter,
      [member],
      [{ memberId: 'model-b', content: 'Draft.', outcome: 'completed', duration: 1 }],
      [{ type: 'text', content: 'Vote on the draft.' }],
      paths.worktreePath,
      'interview_draft',
      300_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketId: ticket.id,
        phase: 'COUNCIL_VOTING_INTERVIEW',
      },
    )).resolves.toMatchObject({
      deadlineReached: false,
      memberOutcomes: { 'model-a': 'failed' },
    })
  })
})
