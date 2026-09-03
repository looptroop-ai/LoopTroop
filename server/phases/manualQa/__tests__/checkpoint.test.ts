import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { insertPhaseArtifact } from '../../../storage/tickets'
import {
  buildFinalTestFileEffectsAudit,
  captureFinalTestDirtyFiles,
} from '../../finalTest/fileEffectsAudit'
import {
  discardManualQaWorkspaceDrift,
  includeManualQaWorkspaceDrift,
  prepareManualQaCheckpoint,
} from '../checkpoint'
import { readManualQaEvents } from '../storage'

const repoManager = createTestRepoManager('manual-qa-checkpoint-')

function git(worktreePath: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', worktreePath, ...args], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    throw new Error(result.error?.message ?? result.stderr ?? `git ${args.join(' ')} failed`)
  }
  return (result.stdout ?? '').trim()
}

async function prepareFixture() {
  const setup = await createInitializedTestTicket(repoManager, { title: 'Manual QA checkpoint' })
  const baseline = captureFinalTestDirtyFiles(setup.paths.worktreePath)
  writeFileSync(resolve(setup.paths.worktreePath, 'README.md'), '# Candidate after final tests\n')
  writeFileSync(resolve(setup.paths.worktreePath, 'final-test.tmp'), 'temporary runtime output\n')
  const after = captureFinalTestDirtyFiles(setup.paths.worktreePath)
  const audit = buildFinalTestFileEffectsAudit({
    baselineDirtyFiles: baseline,
    dirtyFilesAfterTesting: after,
    declaredEffects: [
      { path: 'README.md', intent: 'candidate' },
      { path: 'final-test.tmp', intent: 'temporary' },
    ],
  })
  insertPhaseArtifact(setup.ticket.id, {
    phase: 'RUNNING_FINAL_TEST',
    artifactType: 'final_test_file_effects_audit',
    content: JSON.stringify(audit),
  })
  return setup
}

describe('Manual QA workspace checkpoints', () => {
  beforeEach(() => resetTestDb())
  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('commits accepted final-test effects, keeps local-only residue, and records a delivery-clean baseline', async () => {
    const setup = await prepareFixture()
    const result = prepareManualQaCheckpoint(setup.ticket.id, 1)

    expect(result.checkpointCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(result.candidateFiles).toEqual(['README.md'])
    expect(result.quarantinedFiles).toEqual([])
    expect(readFileSync(resolve(setup.paths.worktreePath, 'README.md'), 'utf8')).toContain('Candidate after final tests')
    expect(existsSync(resolve(setup.paths.worktreePath, 'final-test.tmp'))).toBe(true)
    expect(existsSync(resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine/final-test.tmp'))).toBe(false)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])
    expect(result.baseline.status).toEqual([])
    expect(result.baseline.localOnlyPaths).toEqual(['final-test.tmp'])
    expect(result.baseline.head).toBe(git(setup.paths.worktreePath, 'rev-parse', 'HEAD'))
    expect(result.baseline.trackedSignatures['README.md']).toMatch(/^[0-9a-f]{40}$/)
  })

  it('does not include unrelated pre-staged residue in the candidate checkpoint', async () => {
    const setup = await prepareFixture()
    git(setup.paths.worktreePath, 'add', 'final-test.tmp')

    const result = prepareManualQaCheckpoint(setup.ticket.id, 1)

    expect(result.checkpointCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(git(setup.paths.worktreePath, 'show', '--format=', '--name-only', result.checkpointCommit!))
      .toBe('README.md')
    expect(existsSync(resolve(setup.paths.worktreePath, 'final-test.tmp'))).toBe(true)
    expect(git(setup.paths.worktreePath, 'status', '--porcelain')).toContain('final-test.tmp')
  })

  it('includes dirty drift in a checkpoint and discards only explicitly audited drift', async () => {
    const setup = await prepareFixture()
    prepareManualQaCheckpoint(setup.ticket.id, 1)

    writeFileSync(resolve(setup.paths.worktreePath, 'README.md'), '# User accepted application change\n')
    const included = includeManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'include-drift')
    expect(included.decision).toBe('include')
    expect(includeManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'include-drift')).toEqual(included)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])

    const acceptedContent = readFileSync(resolve(setup.paths.worktreePath, 'README.md'), 'utf8')
    writeFileSync(resolve(setup.paths.worktreePath, 'README.md'), '# Discard this application change\n')
    const discarded = discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'discard-drift')
    expect(discarded.decision).toBe('discard')
    expect(readFileSync(resolve(setup.paths.worktreePath, 'README.md'), 'utf8')).toBe(acceptedContent)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])
    expect(readManualQaEvents(setup.paths.ticketDir).map((event) => event.eventType))
      .toEqual(['drift_included', 'drift_discarded'])
  })

  it('reverts an explicitly audited committed drift path instead of accepting a changed HEAD silently', async () => {
    const setup = await prepareFixture()
    prepareManualQaCheckpoint(setup.ticket.id, 1)

    writeFileSync(resolve(setup.paths.worktreePath, 'app-runtime.txt'), 'committed application residue\n')
    git(setup.paths.worktreePath, 'add', 'app-runtime.txt')
    git(
      setup.paths.worktreePath,
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com',
      'commit', '--no-verify', '-m', 'manual application drift',
    )

    expect(() => discardManualQaWorkspaceDrift(setup.ticket.id, 1, [], 'empty-discard'))
      .toThrow(/resolve every audited file/)
    discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['app-runtime.txt'], 'committed-discard')
    expect(existsSync(resolve(setup.paths.worktreePath, 'app-runtime.txt'))).toBe(false)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])
  })
})
