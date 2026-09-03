import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFixtureRepoManager } from '../../../test/fixtureRepo'
import { prepareSquashCandidate, pushSquashedCandidate, rewriteCandidateCommitWithFiles } from '../squash'
import { TEST } from '../../../test/factories'

const BRANCH = TEST.externalId

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-squash-',
  files: {
    'README.md': 'base\n',
  },
})

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim()
}

afterAll(() => {
  repoManager.cleanup()
})

describe('prepareSquashCandidate', () => {
  it('squashes multiple commits into one', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])
    writeFileSync(resolve(repoDir, 'a.txt'), 'aaa\n')
    git(repoDir, ['add', 'a.txt'])
    git(repoDir, ['commit', '-m', 'add a'])
    writeFileSync(resolve(repoDir, 'b.txt'), 'bbb\n')
    git(repoDir, ['add', 'b.txt'])
    git(repoDir, ['commit', '-m', 'add b'])
    writeFileSync(resolve(repoDir, 'c.txt'), 'ccc\n')
    git(repoDir, ['add', 'c.txt'])
    git(repoDir, ['commit', '-m', 'add c'])

    const result = prepareSquashCandidate(repoDir, 'main', 'Add features', BRANCH)

    expect(result.success).toBe(true)
    expect(result.commitCount).toBe(3)
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/)
    expect(result.message).toContain(BRANCH)

    const commitMsg = git(repoDir, ['log', '-1', '--pretty=%s'])
    expect(commitMsg).toBe(`${BRANCH}: Add features`)
  })

  it('returns failure when no changes exist relative to base', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])

    const result = prepareSquashCandidate(repoDir, 'main', 'Empty', BRANCH)

    expect(result.success).toBe(false)
    expect(result.message).toContain('No candidate changes')
  })

  it('returns failure for an invalid worktree path', () => {
    const result = prepareSquashCandidate('/nonexistent/path', 'main', 'title', BRANCH)

    expect(result.success).toBe(false)
  })

  it('squashes a single commit', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])
    writeFileSync(resolve(repoDir, 'only.txt'), 'only\n')
    git(repoDir, ['add', 'only.txt'])
    git(repoDir, ['commit', '-m', 'only commit'])

    const result = prepareSquashCandidate(repoDir, 'main', 'Single change', BRANCH)

    expect(result.success).toBe(true)
    expect(result.commitCount).toBe(1)
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/)

    const commitMsg = git(repoDir, ['log', '-1', '--pretty=%s'])
    expect(commitMsg).toBe(`${BRANCH}: Single change`)
  })

  it('stages committed bead files plus explicit final-test files without sweeping unrelated worktree changes', () => {
    const repoDir = repoManager.createRepo()

    writeFileSync(resolve(repoDir, 'generated.asset'), 'generated\n')
    git(repoDir, ['add', 'generated.asset'])
    git(repoDir, ['commit', '-m', 'add generated asset'])

    git(repoDir, ['checkout', '-b', BRANCH])
    writeFileSync(resolve(repoDir, 'tracked.ts'), 'export const tracked = 1\n')
    git(repoDir, ['add', 'tracked.ts'])
    git(repoDir, ['commit', '-m', 'tracked change'])

    writeFileSync(resolve(repoDir, 'README.md'), 'base updated\n')
    writeFileSync(resolve(repoDir, 'final.test.ts'), 'export const final = true\n')
    writeFileSync(resolve(repoDir, 'runtime.db'), 'not for commit\n')
    unlinkSync(resolve(repoDir, 'generated.asset'))

    const result = prepareSquashCandidate(repoDir, 'main', 'Selective stage', BRANCH, ['final.test.ts'])

    expect(result.success).toBe(true)
    const showFiles = git(repoDir, ['show', '--pretty=', '--name-only', 'HEAD'])
    expect(showFiles).toContain('tracked.ts')
    expect(showFiles).toContain('final.test.ts')
    expect(showFiles).not.toContain('README.md')
    expect(showFiles).not.toContain('generated.asset')
    expect(showFiles).not.toContain('runtime.db')

    const status = git(repoDir, ['status', '--porcelain'])
    expect(status).toContain('M README.md')
    expect(status).toContain(' D generated.asset')
    expect(status).toContain('?? runtime.db')
  })

  it('excludes committed LoopTroop ticket artifacts from the final candidate', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])
    mkdirSync(resolve(repoDir, '.ticket'), { recursive: true })
    writeFileSync(resolve(repoDir, '.ticket/prd.yaml'), 'prd: internal\n')
    writeFileSync(resolve(repoDir, 'feature.ts'), 'export const feature = true\n')
    git(repoDir, ['add', '.ticket/prd.yaml', 'feature.ts'])
    git(repoDir, ['commit', '-m', 'feature with ticket metadata'])

    const result = prepareSquashCandidate(repoDir, 'main', 'Exclude metadata', BRANCH)

    expect(result.success).toBe(true)
    const showFiles = git(repoDir, ['show', '--pretty=', '--name-only', 'HEAD'])
    expect(showFiles).toContain('feature.ts')
    expect(showFiles).not.toContain('.ticket/prd.yaml')
  })

  it('refuses to rewrite over a dirty worktree instead of resetting it away', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])
    writeFileSync(resolve(repoDir, 'src.ts'), 'export const feature = true\n')
    git(repoDir, ['add', 'src.ts'])
    git(repoDir, ['commit', '-m', 'candidate'])
    const candidate = git(repoDir, ['rev-parse', 'HEAD'])
    const mergeBase = git(repoDir, ['merge-base', 'HEAD', 'main'])

    // Uncommitted work the rewrite's `reset --hard` would destroy.
    writeFileSync(resolve(repoDir, 'src.ts'), 'export const feature = "edited by hand"\n')

    const result = rewriteCandidateCommitWithFiles(
      repoDir,
      mergeBase,
      candidate,
      'Filtered candidate',
      BRANCH,
      ['src.ts'],
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('uncommitted changes')
    expect(readFileSync(resolve(repoDir, 'src.ts'), 'utf8')).toContain('edited by hand')
    expect(git(repoDir, ['rev-parse', 'HEAD'])).toBe(candidate)
  })

  it('rewrites a candidate commit with only AI-audited included files', () => {
    const repoDir = repoManager.createRepo()

    git(repoDir, ['checkout', '-b', BRANCH])
    writeFileSync(resolve(repoDir, 'src.ts'), 'export const feature = true\n')
    writeFileSync(resolve(repoDir, 'tmp.log'), 'temporary output\n')
    writeFileSync(resolve(repoDir, 'generated.js'), 'generated output\n')
    git(repoDir, ['add', 'src.ts', 'tmp.log', 'generated.js'])
    git(repoDir, ['commit', '-m', 'candidate with byproducts'])

    const candidate = git(repoDir, ['rev-parse', 'HEAD'])
    const mergeBase = git(repoDir, ['merge-base', 'HEAD', 'main'])
    const result = rewriteCandidateCommitWithFiles(
      repoDir,
      mergeBase,
      candidate,
      'Filtered candidate',
      BRANCH,
      ['src.ts', 'generated.js'],
    )

    expect(result.success).toBe(true)
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/)
    expect(result.commitHash).not.toBe(candidate)

    const showFiles = git(repoDir, ['show', '--pretty=', '--name-only', 'HEAD'])
    expect(showFiles).toContain('src.ts')
    expect(showFiles).toContain('generated.js')
    expect(showFiles).not.toContain('tmp.log')
    expect(git(repoDir, ['status', '--porcelain'])).toBe('')
  })
})

describe('pushSquashedCandidate', () => {
  it('returns failure when no remote is configured', async () => {
    const repoDir = repoManager.createRepo()

    const result = await pushSquashedCandidate(repoDir)

    expect(result.pushed).toBe(false)
    expect(result.error).toMatch(/push failed/i)
  })
})
