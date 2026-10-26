import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { insertPhaseArtifact } from '../../../storage/ticketArtifacts'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { buildBead } from '../../../test/factories'
import { writeJsonl } from '../../../io/jsonl'
import type { ExecutionResult } from '../executor'
import {
  findRecoverableSuccessfulCheckpoint,
  hasSuccessfulExecutionCheckpointForFinalization,
  isCurrentExecutionCheckpoint,
  isPersistedExecutionResult,
  withExecutionCheckpoint,
} from '../checkpoint'

const repoManager = createTestRepoManager('execution-checkpoint-')

function resultFor(beadId: string, iteration: number, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    beadId,
    success: true,
    iteration,
    output: 'Bead completed.',
    errors: [],
    ...overrides,
  }
}

function saveExecutionArtifact(ticketId: string, artifactBeadId: string, value: unknown): void {
  insertPhaseArtifact(ticketId, {
    phase: 'CODING',
    artifactType: `bead_execution:${artifactBeadId}`,
    content: typeof value === 'string' ? value : JSON.stringify(value),
  })
}

describe('execution checkpoints', () => {
  beforeEach(() => resetTestDb())

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('recovers a successful checkpoint only while its bead metadata is current', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, { title: 'Recover current execution checkpoint' })
    const bead = buildBead({
      status: 'in_progress',
      iteration: 2,
      startedAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:30:00.000Z',
      beadStartCommit: 'base-commit',
    })
    const checkpoint = withExecutionCheckpoint(resultFor(bead.id, bead.iteration), bead)
    saveExecutionArtifact(ticket.id, bead.id, checkpoint)
    writeJsonl(paths.beadsPath, [bead])

    expect(isPersistedExecutionResult(checkpoint, bead.id)).toBe(true)
    expect(isCurrentExecutionCheckpoint(checkpoint, bead)).toBe(true)
    expect(findRecoverableSuccessfulCheckpoint(ticket.id, [bead])).toEqual(bead)
    expect(hasSuccessfulExecutionCheckpointForFinalization(ticket.id)).toBe(true)
  })

  it.each([
    ['iteration', { iteration: 3 }],
    ['start time', { startedAt: '2026-10-01T10:01:00.000Z' }],
    ['update time', { updatedAt: '2026-10-01T10:31:00.000Z' }],
    ['start commit', { beadStartCommit: 'new-base-commit' }],
  ] as const)('rejects a checkpoint after the bead %s changes', (_, changedMetadata) => {
    const previous = buildBead({
      iteration: 2,
      startedAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:30:00.000Z',
      beadStartCommit: 'base-commit',
    })
    const checkpoint = withExecutionCheckpoint(resultFor(previous.id, previous.iteration), previous)
    const current = buildBead({ ...previous, ...changedMetadata })

    expect(isCurrentExecutionCheckpoint(checkpoint, current)).toBe(false)
  })

  it('does not recover a checkpoint when its execution failed', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, { title: 'Ignore failed execution checkpoint' })
    const bead = buildBead({ status: 'error' })
    const failed = withExecutionCheckpoint(resultFor(bead.id, bead.iteration, { success: false }), bead)
    saveExecutionArtifact(ticket.id, bead.id, failed)

    expect(isCurrentExecutionCheckpoint(failed, bead)).toBe(true)
    expect(findRecoverableSuccessfulCheckpoint(ticket.id, [bead])).toBeNull()
    expect(hasSuccessfulExecutionCheckpointForFinalization(ticket.id)).toBe(false)
  })

  it('does not attach a persisted result for another bead to the current bead', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, { title: 'Ignore wrong-bead execution checkpoint' })
    const bead = buildBead({ status: 'error' })
    const wrongBead = withExecutionCheckpoint(resultFor('bead-2', bead.iteration), bead)
    saveExecutionArtifact(ticket.id, bead.id, wrongBead)

    expect(isPersistedExecutionResult(wrongBead, bead.id)).toBe(false)
    expect(findRecoverableSuccessfulCheckpoint(ticket.id, [bead])).toBeNull()
  })

  it.each(['null', 'missing metadata', 'malformed metadata', 'invalid errors', 'invalid codes'])(
    'refuses finalization recovery from a corrupt record: %s', async (corruption) => {
      const { ticket } = await createInitializedTestTicket(repoManager)
      const bead = buildBead({ status: 'error' })
      const valid = withExecutionCheckpoint(resultFor(bead.id, bead.iteration), bead)
      const corrupt = corruption === 'null' ? null
        : corruption === 'missing metadata' ? { ...valid, checkpoint: undefined }
        : corruption === 'malformed metadata' ? { ...valid, checkpoint: { ...valid.checkpoint, iteration: '2' } }
        : corruption === 'invalid errors' ? { ...valid, errors: [42] }
        : { ...valid, errorCodes: [42] }
      saveExecutionArtifact(ticket.id, bead.id, corrupt)
      expect(findRecoverableSuccessfulCheckpoint(ticket.id, [bead])).toBeNull()
    },
  )

  it('ignores malformed execution checkpoint JSON', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, { title: 'Ignore malformed execution checkpoint' })
    const bead = buildBead({ status: 'in_progress' })
    saveExecutionArtifact(ticket.id, bead.id, '{invalid JSON')

    expect(findRecoverableSuccessfulCheckpoint(ticket.id, [bead])).toBeNull()
  })
})
