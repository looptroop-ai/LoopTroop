import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, pinGitLineEndings, removeTempDir } from '../../../test/tempDir'
import {
  buildFinalTestFileEffectsAudit,
  captureFinalTestDirtyFiles,
  restoreTrackedFinalTestLocalFiles,
  type FinalTestDirtyFile,
} from '../fileEffectsAudit'

function dirtyFile(path: string, overrides: Partial<FinalTestDirtyFile> = {}): FinalTestDirtyFile {
  return {
    path,
    indexStatus: '?',
    worktreeStatus: '?',
    rawStatus: '??',
    untracked: true,
    contentSignature: 'hash',
    ...overrides,
  }
}

describe('buildFinalTestFileEffectsAudit', () => {
  it('captures an explicitly declared ignored file without exposing other ignored files', () => {
    const repo = makeTempDir('final-test-explicit-ignore-')
    try {
      spawnSync('git', ['init', '-q', repo])
      pinGitLineEndings(repo)
      writeFileSync(join(repo, '.gitignore'), 'coverage/\n')
      mkdirSync(join(repo, 'coverage'), { recursive: true })
      writeFileSync(join(repo, 'coverage', 'candidate.json'), '{"keep":true}\n')
      writeFileSync(join(repo, 'coverage', 'local.json'), '{"keep":false}\n')

      expect(captureFinalTestDirtyFiles(repo).map((file) => file.path)).toEqual(['.gitignore'])
      expect(
        captureFinalTestDirtyFiles(repo, ['coverage/candidate.json']).map((file) => file.path),
      ).toEqual(['.gitignore', 'coverage/candidate.json'])
    } finally {
      removeTempDir(repo)
    }
  })

  it('audits both halves of a rename, not just where the file landed', () => {
    const repo = makeTempDir('final-test-rename-')
    try {
      spawnSync('git', ['init', '-q', repo])
      pinGitLineEndings(repo)
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
      writeFileSync(join(repo, 'original.ts'), 'export const value = 1\n')
      spawnSync('git', ['-C', repo, 'add', '.'])
      spawnSync('git', ['-C', repo, 'commit', '-m', 'initial'])
      spawnSync('git', ['-C', repo, 'mv', 'original.ts', 'moved.ts'])

      // git -z reports a rename as one record carrying two paths. Reading only
      // the first left the file's disappearance out of the audit entirely.
      const audited = captureFinalTestDirtyFiles(repo)
      expect(audited.map((file) => file.path).sort()).toEqual(['moved.ts', 'original.ts'])
      expect(audited.find((file) => file.path === 'original.ts')?.indexStatus).toBe('D')
    } finally {
      removeTempDir(repo)
    }
  })

  it('does not report the source of a copy as deleted', () => {
    const repo = makeTempDir('final-test-copy-')
    try {
      spawnSync('git', ['init', '-q', repo])
      pinGitLineEndings(repo)
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
      spawnSync('git', ['-C', repo, 'config', 'status.renames', 'copies'])
      writeFileSync(join(repo, 'source.ts'), 'export const value = 1\n')
      spawnSync('git', ['-C', repo, 'add', '.'])
      spawnSync('git', ['-C', repo, 'commit', '-m', 'initial'])
      writeFileSync(join(repo, 'copy.ts'), 'export const value = 1\n')
      spawnSync('git', ['-C', repo, 'add', '.'])

      const audited = captureFinalTestDirtyFiles(repo)
      expect(audited.map((file) => file.path)).toContain('copy.ts')
      // The source is untouched; recording it as deleted would stage a removal
      // nobody asked for.
      expect(audited.some((file) => file.path === 'source.ts' && file.indexStatus === 'D')).toBe(false)
    } finally {
      removeTempDir(repo)
    }
  })

  it('restores tracked local-only mutations without removing untracked local outputs', () => {
    const repo = makeTempDir('final-test-tracked-local-')
    try {
      spawnSync('git', ['init', '-q', repo])
      pinGitLineEndings(repo)
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
      writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
      spawnSync('git', ['-C', repo, 'add', 'tracked.txt'])
      spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture'])
      const baseline = captureFinalTestDirtyFiles(repo)
      writeFileSync(join(repo, 'tracked.txt'), 'temporary mutation\n')
      writeFileSync(join(repo, 'local.tmp'), 'keep locally\n')
      const after = captureFinalTestDirtyFiles(repo)
      const audit = buildFinalTestFileEffectsAudit({
        baselineDirtyFiles: baseline,
        dirtyFilesAfterTesting: after,
        declaredEffects: [
          { path: 'tracked.txt', intent: 'temporary' },
          { path: 'local.tmp', intent: 'temporary' },
        ],
      })

      expect(restoreTrackedFinalTestLocalFiles(repo, audit)).toEqual(['tracked.txt'])
      expect(captureFinalTestDirtyFiles(repo).map((file) => file.path)).toEqual(['local.tmp'])
    } finally {
      removeTempDir(repo)
    }
  })

  it('uses explicit candidate intent even for generated-looking files', () => {
    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [],
      dirtyFilesAfterTesting: [dirtyFile('coverage/final-report.json')],
      declaredEffects: [{
        path: 'coverage/final-report.json',
        intent: 'candidate',
        reason: 'Requested versioned fixture',
      }],
      capturedAt: '2026-05-26T00:00:00.000Z',
    })

    expect(audit.status).toBe('passed')
    expect(audit.candidateFiles).toEqual(['coverage/final-report.json'])
    expect(audit.localOnlyFiles).toEqual([])
    expect(audit.resolvedEffects).toEqual([{
      path: 'coverage/final-report.json',
      disposition: 'candidate',
      reason: 'declared_candidate',
      detail: 'Requested versioned fixture',
    }])
  })

  it.each([
    ['temporary', 'declared_temporary'],
    ['unexpected', 'declared_unexpected'],
  ] as const)('keeps an explicitly declared %s file local even when tracked', (intent, reason) => {
    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [],
      dirtyFilesAfterTesting: [dirtyFile('tracked-output.txt', {
        indexStatus: 'M',
        worktreeStatus: ' ',
        rawStatus: 'M ',
        untracked: false,
      })],
      declaredEffects: [{ path: 'tracked-output.txt', intent }],
      capturedAt: '2026-05-26T00:00:00.000Z',
    })

    expect(audit.candidateFiles).toEqual([])
    expect(audit.localOnlyFiles).toEqual(['tracked-output.txt'])
    expect(audit.resolvedEffects[0]).toMatchObject({
      disposition: 'local_only',
      reason,
    })
  })

  it('keeps undeclared tracked or staged files in the candidate', () => {
    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [],
      dirtyFilesAfterTesting: [
        dirtyFile('src/tracked.ts', {
          indexStatus: ' ',
          worktreeStatus: 'M',
          rawStatus: ' M',
          untracked: false,
        }),
        dirtyFile('src/staged-new.ts', {
          indexStatus: 'A',
          worktreeStatus: ' ',
          rawStatus: 'A ',
          untracked: false,
        }),
      ],
      declaredEffects: [],
    })

    expect(audit.candidateFiles).toEqual(['src/tracked.ts', 'src/staged-new.ts'])
    expect(audit.resolvedEffects.map(({ path, reason }) => ({ path, reason }))).toEqual([
      { path: 'src/tracked.ts', reason: 'tracked' },
      { path: 'src/staged-new.ts', reason: 'tracked' },
    ])
  })

  it('keeps untracked generated and setup outputs local without warnings', () => {
    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [],
      dirtyFilesAfterTesting: [
        dirtyFile('node_modules/.vite/vitest/results.json'),
        dirtyFile('.ticket-tools/downloads/compiler'),
      ],
      declaredEffects: [],
      setupExcludedRoots: ['.ticket-tools'],
    })

    expect(audit.status).toBe('passed')
    expect(audit.candidateFiles).toEqual([])
    expect(audit.localOnlyFiles).toEqual([
      'node_modules/.vite/vitest/results.json',
      '.ticket-tools/downloads/compiler',
    ])
    expect(audit.classificationRequiredFiles).toEqual([])
    expect(audit.classificationRetry).toEqual({
      status: 'not_needed',
      requestedFiles: [],
    })
    expect(audit.warnings).toEqual([])
    expect(audit.resolvedEffects.map(({ reason }) => reason)).toEqual([
      'generated_noise',
      'setup_temporary',
    ])
  })

  it('keeps an unknown untracked file local and exposes it for one classification retry', () => {
    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [],
      dirtyFilesAfterTesting: [dirtyFile('diagnostics/final-output.txt')],
      declaredEffects: [],
      capturedAt: '2026-05-26T00:00:00.000Z',
    })

    expect(audit.status).toBe('passed')
    expect(audit.candidateFiles).toEqual([])
    expect(audit.localOnlyFiles).toEqual(['diagnostics/final-output.txt'])
    expect(audit.classificationRequiredFiles).toEqual(['diagnostics/final-output.txt'])
    expect(audit.classificationRetry).toEqual({
      status: 'fallback',
      requestedFiles: ['diagnostics/final-output.txt'],
    })
    expect(audit.warnings).toEqual([
      'Undeclared untracked file was kept locally and excluded from delivery: diagnostics/final-output.txt',
    ])
    expect(audit.message).toBe('Final-test file effects were resolved with 1 warning(s).')
  })

  it('ignores files that were already dirty and unchanged before final testing', () => {
    const baseline = dirtyFile('README.md', {
      indexStatus: ' ',
      worktreeStatus: 'M',
      rawStatus: ' M',
      untracked: false,
      contentSignature: 'before',
    })

    const audit = buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: [baseline],
      dirtyFilesAfterTesting: [baseline],
      declaredEffects: [],
      capturedAt: '2026-05-26T00:00:00.000Z',
    })

    expect(audit.status).toBe('passed')
    expect(audit.producedByFinalTesting).toEqual([])
    expect(audit.resolvedEffects).toEqual([])
  })
})
