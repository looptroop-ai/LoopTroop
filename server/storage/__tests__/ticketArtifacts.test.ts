import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcaster } from '../../sse/broadcaster'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import {
  compareAndSetLatestPhaseArtifact,
  getLatestPhaseArtifact,
  insertPhaseArtifact,
  listPhaseArtifacts,
  upsertLatestPhaseArtifact,
} from '../ticketArtifacts'
import { archiveActivePhaseAttempts, ensureActivePhaseAttempt } from '../ticketPhaseAttempts'

const repoManager = createTestRepoManager('ticket-artifact-cas')

describe('ticket artifact compare-and-set', () => {
  beforeEach(() => resetTestDb())

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('updates only the expected latest content and keeps artifact broadcasts', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const first = JSON.stringify({ revision: 1 })
    const second = JSON.stringify({ revision: 2 })
    const stale = JSON.stringify({ revision: 3 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', first)

    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      second,
    )).toBe(true)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS')?.content).toBe(second)
    expect(broadcast).toHaveBeenCalledWith(ticket.id, 'artifact_change', expect.objectContaining({
      artifactType: 'interview_session',
    }))

    broadcast.mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      stale,
    )).toBe(false)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS')?.content).toBe(second)
    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRestore()
  })

  it('keeps archived phase attempts read-only', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    ensureActivePhaseAttempt(ticket.id, 'WAITING_INTERVIEW_ANSWERS')
    const first = JSON.stringify({ revision: 1 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', first, 1)
    archiveActivePhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'], 'test archive')

    expect(() => compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      JSON.stringify({ revision: 2 }),
      1,
    )).toThrow(/Archived WAITING_INTERVIEW_ANSWERS attempt 1 is read-only/)
  })

  it('does not update a historical matching row when a newer row differs', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const historical = JSON.stringify({ revision: 1 })
    const current = JSON.stringify({ revision: 2 })
    const replacement = JSON.stringify({ revision: 3 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', historical)
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
      artifactType: 'interview_session',
      content: current,
    })

    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      historical,
      replacement,
    )).toBe(false)
    expect(listPhaseArtifacts(ticket.id, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
    }).map((artifact) => artifact.content)).toEqual([historical, current])
    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRestore()
  })
})
