import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { makePrdYaml, TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, insertPhaseArtifact, writeTicketFile } from '../../storage/tickets'

const { runOpenCodePromptMock } = vi.hoisted(() => ({
  runOpenCodePromptMock: vi.fn(),
}))

vi.mock('../../opencode/factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../opencode/factory')>()),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../runOpenCodePrompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runOpenCodePrompt')>()),
  runOpenCodePrompt: runOpenCodePromptMock,
}))

import { handleCoverageVerification } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('verification-prd-artifact-recovery-')

describe('PRD coverage artifact recovery', () => {
  beforeEach(() => {
    resetTestDb()
    runOpenCodePromptMock.mockReset()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('restores the validated phase-scoped PRD when the newest unscoped refinement artifact is malformed', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const winnerId = TEST.councilMembers[0]
    const refinedContent = makePrdYaml({ ticketId: ticket.externalId })
    writeTicketFile(ticket.id, 'prd.yaml', '  \n')

    insertPhaseArtifact(ticket.id, {
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: JSON.stringify({
        drafts: [{ memberId: winnerId, outcome: 'completed', content: 'The winner supplied complete PRD answers.' }],
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId,
        refinedContent,
        winnerDraftContent: refinedContent,
        draftMetrics: { epicCount: 1, userStoryCount: 1 },
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_refined',
      content: '{ malformed latest refinement',
    })
    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'prd-recovery-coverage', projectPath: paths.worktreePath },
      response: ['status: clean', 'gaps: []', 'follow_up_questions: []'].join('\n'),
      messages: [],
    })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'prd', new AbortController().signal)

    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8').trim()).toBe(refinedContent.trim())
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'prd_coverage_input', 'VERIFYING_PRD_COVERAGE')!.content))
      .toMatchObject({ candidateVersion: 1, refinedContent })
    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })
})
