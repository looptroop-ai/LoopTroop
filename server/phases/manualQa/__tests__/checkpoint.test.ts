import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
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
    const result = await prepareManualQaCheckpoint(setup.ticket.id, 1)

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

  it('keeps a whitespace-only filename present through NUL staged-field detection', async () => {
    const setup = await createInitializedTestTicket(repoManager, { title: 'Manual QA whitespace path' })
    const baseline = captureFinalTestDirtyFiles(setup.paths.worktreePath)
    // A whitespace-only basename is valid on POSIX but Windows strips trailing
    // spaces. Internal whitespace keeps the NUL field-presence assertion
    // portable without pretending the POSIX-only name is legal everywhere.
    const unusual = process.platform === 'win32' ? 'qa whitespace.txt' : '   '
    writeFileSync(resolve(setup.paths.worktreePath, unusual), 'candidate\n')
    const after = captureFinalTestDirtyFiles(setup.paths.worktreePath)
    insertPhaseArtifact(setup.ticket.id, {
      phase: 'RUNNING_FINAL_TEST',
      artifactType: 'final_test_file_effects_audit',
      content: JSON.stringify(buildFinalTestFileEffectsAudit({
        baselineDirtyFiles: baseline,
        dirtyFilesAfterTesting: after,
        declaredEffects: [{ path: unusual, intent: 'candidate' }],
      })),
    })

    const result = await prepareManualQaCheckpoint(setup.ticket.id, 1)
    expect(result.candidateFiles).toEqual([unusual])
    const shown = spawnSync(
      'git',
      ['-C', setup.paths.worktreePath, 'show', '--format=', '--name-only', '-z', result.checkpointCommit!],
      { encoding: 'buffer' },
    )
    expect(shown.status).toBe(0)
    expect((shown.stdout as Buffer).includes(Buffer.from(`${unusual}\0`))).toBe(true)
  })

  it('does not include unrelated pre-staged residue in the candidate checkpoint', async () => {
    const setup = await prepareFixture()
    git(setup.paths.worktreePath, 'add', 'final-test.tmp')

    const result = await prepareManualQaCheckpoint(setup.ticket.id, 1)

    expect(result.checkpointCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(git(setup.paths.worktreePath, 'show', '--format=', '--name-only', result.checkpointCommit!))
      .toBe('README.md')
    expect(existsSync(resolve(setup.paths.worktreePath, 'final-test.tmp'))).toBe(true)
    expect(git(setup.paths.worktreePath, 'status', '--porcelain')).toContain('final-test.tmp')
  })

  it('includes dirty drift in a checkpoint and discards only explicitly audited drift', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)

    writeFileSync(resolve(setup.paths.worktreePath, 'README.md'), '# User accepted application change\n')
    const included = await includeManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'include-drift')
    expect(included.decision).toBe('include')
    await expect(includeManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'include-drift')).resolves.toEqual(included)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])

    const acceptedContent = readFileSync(resolve(setup.paths.worktreePath, 'README.md'), 'utf8')
    writeFileSync(resolve(setup.paths.worktreePath, 'README.md'), '# Discard this application change\n')
    const discarded = await discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'discard-drift')
    expect(discarded.decision).toBe('discard')
    expect(readFileSync(resolve(setup.paths.worktreePath, 'README.md'), 'utf8')).toBe(acceptedContent)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])
    expect(readManualQaEvents(setup.paths.ticketDir).map((event) => event.eventType))
      .toEqual(['drift_included', 'drift_discarded'])
  })

  it('reuses identical quarantine bytes and preserves later same-sized drift separately', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)
    const source = resolve(setup.paths.worktreePath, 'README.md')
    const content = Buffer.alloc(128 * 1024 + 7, 'a')
    const destination = resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine/README.md')
    mkdirSync(resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine'), { recursive: true })
    writeFileSync(source, content)
    writeFileSync(destination, content)

    const first = await discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'same-backup')
    expect(first.quarantinePaths?.['README.md']).toBe(destination)
    content[content.length - 1] = 98
    writeFileSync(source, content)
    const second = await discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'new-backup')
    const retryPath = second.quarantinePaths?.['README.md']
    expect(retryPath).toContain(`${destination}.attempt-`)
    expect(readFileSync(destination).at(-1)).toBe(97)
    expect(readFileSync(retryPath!)).toEqual(content)
  })

  it('reverts an explicitly audited committed drift path instead of accepting a changed HEAD silently', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)

    writeFileSync(resolve(setup.paths.worktreePath, 'app-runtime.txt'), 'committed application residue\n')
    git(setup.paths.worktreePath, 'add', 'app-runtime.txt')
    git(
      setup.paths.worktreePath,
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com',
      'commit', '--no-verify', '-m', 'manual application drift',
    )

    await expect(discardManualQaWorkspaceDrift(setup.ticket.id, 1, [], 'empty-discard'))
      .rejects.toThrow(/resolve every audited file/)
    await discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['app-runtime.txt'], 'committed-discard')
    expect(existsSync(resolve(setup.paths.worktreePath, 'app-runtime.txt'))).toBe(false)
    expect(captureFinalTestDirtyFiles(setup.paths.worktreePath).map(file => file.path)).toEqual(['final-test.tmp'])
  })

  it('rejects an escaping quarantine link before copying or discarding drift', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)
    const source = resolve(setup.paths.worktreePath, 'README.md')
    writeFileSync(source, '# Keep this drift\n')
    const outside = resolve(setup.paths.worktreePath, 'quarantine-outside')
    mkdirSync(outside)
    mkdirSync(resolve(setup.paths.ticketDir, 'manual-qa/v1'), { recursive: true })
    symlinkSync(outside, resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'unsafe-quarantine'))
      .rejects.toThrow('Manual QA path escapes its contained root')
    expect(readFileSync(source, 'utf8')).toBe('# Keep this drift\n')
    expect(existsSync(resolve(outside, 'README.md'))).toBe(false)
  })

  it('quarantines outward and dangling links without following or losing their targets', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)
    const outward = resolve(setup.paths.worktreePath, 'qa-outward-link')
    const dangling = resolve(setup.paths.worktreePath, 'qa-dangling-link')
    const outside = resolve(setup.paths.worktreePath, '..', '..', 'outside-qa-target.txt')
    writeFileSync(outside, 'private target\n')
    symlinkSync(outside, outward)
    symlinkSync(resolve(setup.paths.worktreePath, 'missing-qa-target.txt'), dangling)

    const result = await discardManualQaWorkspaceDrift(
      setup.ticket.id,
      1,
      ['qa-outward-link', 'qa-dangling-link'],
      'discard-links',
    )

    expect(result.files).toEqual(['qa-outward-link', 'qa-dangling-link'])
    for (const name of ['qa-outward-link', 'qa-dangling-link']) {
      const quarantined = resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine', name)
      expect(lstatSync(quarantined).isSymbolicLink()).toBe(true)
      expect(readlinkSync(quarantined)).toBe(name === 'qa-outward-link' ? outside : resolve(setup.paths.worktreePath, 'missing-qa-target.txt'))
      expect(existsSync(resolve(setup.paths.worktreePath, name))).toBe(false)
    }
    expect(readFileSync(outside, 'utf8')).toBe('private target\n')
  })

  it('rejects a quarantine link into other ticket artifacts before overwriting or discarding drift', async () => {
    const setup = await prepareFixture()
    await prepareManualQaCheckpoint(setup.ticket.id, 1)
    const source = resolve(setup.paths.worktreePath, 'README.md')
    writeFileSync(source, '# Keep this drift\n')
    const protectedArtifacts = resolve(setup.paths.ticketDir, 'protected-artifacts')
    mkdirSync(protectedArtifacts)
    writeFileSync(resolve(protectedArtifacts, 'README.md'), 'original artifact')
    mkdirSync(resolve(setup.paths.ticketDir, 'manual-qa/v1'), { recursive: true })
    symlinkSync(protectedArtifacts, resolve(setup.paths.ticketDir, 'manual-qa/v1/quarantine'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(discardManualQaWorkspaceDrift(setup.ticket.id, 1, ['README.md'], 'redirected-quarantine'))
      .rejects.toThrow('quarantine path redirects')
    expect(readFileSync(source, 'utf8')).toBe('# Keep this drift\n')
    expect(readFileSync(resolve(protectedArtifacts, 'README.md'), 'utf8')).toBe('original artifact')
  })

  it('rejects escaped baseline storage before committing the candidate', async () => {
    const setup = await prepareFixture()
    const outside = resolve(setup.paths.worktreePath, 'outside-receipts')
    mkdirSync(outside)
    symlinkSync(outside, resolve(setup.paths.ticketDir, 'manual-qa'), process.platform === 'win32' ? 'junction' : 'dir')
    const head = git(setup.paths.worktreePath, 'rev-parse', 'HEAD')

    await expect(prepareManualQaCheckpoint(setup.ticket.id, 1)).rejects.toThrow('Manual QA path escapes its contained root')
    expect(git(setup.paths.worktreePath, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(resolve(outside, 'workspace-baseline-v1.json'))).toBe(false)
  })

  it('rejects a linked baseline file before reading it or committing the candidate', async () => {
    const setup = await prepareFixture()
    const outside = resolve(setup.paths.worktreePath, 'outside-baseline')
    mkdirSync(outside)
    mkdirSync(resolve(setup.paths.ticketDir, 'manual-qa'))
    symlinkSync(outside, resolve(setup.paths.ticketDir, 'manual-qa/workspace-baseline-v1.json'), process.platform === 'win32' ? 'junction' : 'dir')
    const head = git(setup.paths.worktreePath, 'rev-parse', 'HEAD')

    await expect(prepareManualQaCheckpoint(setup.ticket.id, 1)).rejects.toThrow('Manual QA path escapes its contained root')
    expect(git(setup.paths.worktreePath, 'rev-parse', 'HEAD')).toBe(head)
  })
})
