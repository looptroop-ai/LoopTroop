import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePrdYaml } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { insertPhaseArtifact, writeTicketFile } from '../../storage/tickets'
import { handleCoverageVerification } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('verification-phase-guard-coverage-')

const coverageWinners = [
  { phase: 'interview', artifactType: 'interview_winner', artifactPhase: 'COMPILING_INTERVIEW' },
  { phase: 'prd', artifactType: 'prd_winner', artifactPhase: 'REFINING_PRD' },
  { phase: 'beads', artifactType: 'beads_winner', artifactPhase: 'REFINING_BEADS' },
] as const

async function expectCoverageError(
  ticketId: string,
  context: Parameters<typeof handleCoverageVerification>[1],
  phase: Parameters<typeof handleCoverageVerification>[3],
  message: string,
) {
  const sendEvent = vi.fn()
  await handleCoverageVerification(ticketId, context, sendEvent, phase, new AbortController().signal)
  expect(sendEvent).toHaveBeenCalledWith({ type: 'ERROR', message, codes: ['COVERAGE_FAILED'] })
}

describe('verification phase persisted-input guards', () => {
  beforeEach(() => resetTestDb())

  afterAll(() => {
    repoManager.cleanup()
  })

  it('reports missing, malformed, and winner-less persisted artifacts for each coverage phase', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)

    for (const { phase, artifactType, artifactPhase } of coverageWinners) {
      await expectCoverageError(
        ticket.id,
        context,
        phase,
        `No persisted council winner found for ${phase} phase: cannot determine winning model`,
      )

      insertPhaseArtifact(ticket.id, { phase: artifactPhase, artifactType, content: '{' })
      await expectCoverageError(
        ticket.id,
        context,
        phase,
        `Failed to parse winning model from persisted artifact for ${phase} phase`,
      )

      insertPhaseArtifact(ticket.id, { phase: artifactPhase, artifactType, content: '{}' })
      await expectCoverageError(
        ticket.id,
        context,
        phase,
        `No winnerId found in persisted artifact for ${phase} phase`,
      )
    }
  })

  it('rejects stale coverage retries before looking for a winner', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    context.lockedMaxCoveragePasses = 1
    insertPhaseArtifact(ticket.id, {
      phase: 'VERIFYING_INTERVIEW_COVERAGE',
      artifactType: 'interview_coverage',
      content: JSON.stringify({ status: 'gaps' }),
    })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'interview', new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_LIMIT_REACHED' })
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ERROR' }))
  })

  it('fails cleanly when interview state or the PRD winner answers are missing', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    insertPhaseArtifact(ticket.id, {
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId: 'interview-winner' }),
    })
    await expectCoverageError(
      ticket.id,
      context,
      'interview',
      'Interview coverage requires canonical interview state, but no normalized interview session snapshot was found.',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_winner',
      content: JSON.stringify({ winnerId: 'prd-winner' }),
    })
    writeTicketFile(ticket.id, 'prd.yaml', makePrdYaml({ ticketId: ticket.externalId }))
    await expectCoverageError(
      ticket.id,
      context,
      'prd',
      "PRD coverage requires the winning model's Full Answers artifact for prd-winner, but it was not available.",
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: '{',
    })
    await expectCoverageError(
      ticket.id,
      context,
      'prd',
      "PRD coverage requires the winning model's Full Answers artifact for prd-winner, but it was not available.",
    )

    writeTicketFile(ticket.id, 'prd.yaml', '  \n')
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: '{',
    })
    await expectCoverageError(
      ticket.id,
      context,
      'prd',
      'PRD coverage requires a canonical prd.yaml or recovered prd_refined artifact, but neither was available.',
    )
  })

  it('rejects beads coverage without an approved PRD, missing blueprint, or valid semantic blueprint', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId: 'beads-winner' }),
    })
    writeTicketFile(ticket.id, 'prd.yaml', '')
    await expectCoverageError(
      ticket.id,
      context,
      'beads',
      'Beads coverage requires an approved PRD, but prd.yaml was not available.',
    )

    writeTicketFile(ticket.id, 'prd.yaml', makePrdYaml({ ticketId: ticket.externalId }))
    await expectCoverageError(
      ticket.id,
      context,
      'beads',
      'Beads coverage requires a canonical semantic beads blueprint or recovered beads coverage revision artifact, but neither was available.',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: '{',
    })
    await expectCoverageError(
      ticket.id,
      context,
      'beads',
      'Beads coverage requires a canonical semantic beads blueprint or recovered beads coverage revision artifact, but neither was available.',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage_revision',
      content: '{',
    })
    await expectCoverageError(
      ticket.id,
      context,
      'beads',
      'Beads coverage requires a canonical semantic beads blueprint or recovered beads coverage revision artifact, but neither was available.',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage_revision',
      content: JSON.stringify({ refinedContent: 'not a beads document', candidateVersion: 1 }),
    })
    const sendEvent = vi.fn()
    await handleCoverageVerification(ticket.id, context, sendEvent, 'beads', new AbortController().signal)
    const errorEvent = sendEvent.mock.calls[0]?.[0]
    expect(errorEvent).toMatchObject({ type: 'ERROR', codes: ['COVERAGE_FAILED'] })
    if (errorEvent?.type === 'ERROR') {
      expect(errorEvent.message).toContain('Beads coverage requires a valid semantic blueprint, but the recovered artifact failed validation:')
    }
  })
})
