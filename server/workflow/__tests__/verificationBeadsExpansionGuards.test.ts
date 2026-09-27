import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertPhaseArtifact, writeTicketFile } from '../../storage/tickets'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { handleBeadsExpansion } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('verification-beads-expansion-guards-')

async function expectExpansionError(
  ticketId: string,
  context: Parameters<typeof handleBeadsExpansion>[1],
  message: string,
) {
  const sendEvent = vi.fn()
  await handleBeadsExpansion(ticketId, context, sendEvent, new AbortController().signal)
  expect(sendEvent).toHaveBeenCalledWith({ type: 'ERROR', message, codes: ['COVERAGE_FAILED'] })
}

describe('beads expansion persisted-input guards', () => {
  beforeEach(() => resetTestDb())

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('reports missing, malformed, and winner-less expansion artifacts', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)

    await expectExpansionError(
      ticket.id,
      context,
      'No persisted council winner found for beads — cannot determine winning model for expansion',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: '{',
    })
    await expectExpansionError(
      ticket.id,
      context,
      'Failed to parse winning model from persisted artifact for beads expansion',
    )

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: '{}',
    })
    await expectExpansionError(
      ticket.id,
      context,
      'No winnerId found in persisted artifact for beads expansion',
    )
  })

  it('requires an approved PRD after loading a valid semantic blueprint', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const winnerId = 'openai/gpt-5-mini'
    const blueprint = [
      'beads:',
      '  - id: "bead-1"',
      '    title: "Validate persisted expansion inputs"',
      '    prdRefs: ["EPIC-1 / US-1"]',
      '    description: "Keep expansion tied to approved requirements."',
      '    contextGuidance: |',
      '      Patterns:',
      '      - Keep behavior traceable.',
      '      Anti-patterns:',
      '      - Do not add unrelated work.',
      '    acceptanceCriteria:',
      '      - "The bead maps to a requirement."',
      '    tests:',
      '      - "The workflow reports missing prerequisites."',
      '    testCommands:',
      '      - mode: "process"',
      '        program: "npm"',
      '        args: ["test"]',
      '        cwd: "."',
      '        env: {}',
    ].join('\n')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({ winnerId, refinedContent: blueprint }),
    })
    writeTicketFile(ticket.id, 'prd.yaml', '  \n')

    await expectExpansionError(
      ticket.id,
      context,
      'Beads expansion requires an approved PRD, but prd.yaml was not available.',
    )
  })
})
