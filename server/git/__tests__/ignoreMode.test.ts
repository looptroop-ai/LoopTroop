import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyIgnoreMode, areLoopTroopPathsIgnored } from '../repository'

/**
 * 2.15 contract: `doctor` re-checks the ignore choice, because a repository's
 * ignore rules belong to its authors. A colleague can rewrite .gitignore, a
 * rebase can drop it, and a project attached with "skip" can stop handling the
 * rules on its own — none of which LoopTroop is told about.
 *
 * The check asks git rather than reading a file, so it is right regardless of
 * which of the several places an ignore rule can come from is providing it.
 */
describe('areLoopTroopPathsIgnored', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  function createRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-ignore-mode-'))
    roots.push(root)
    execFileSync('git', ['-C', root, 'init'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, 'config', 'user.name', 'LoopTroop Tests'], { stdio: 'pipe' })
    return root
  }

  it('is false for a repository nothing has been written into yet', () => {
    expect(areLoopTroopPathsIgnored(createRepo())).toBe(false)
  })

  it('is true once the rules are in the repository .gitignore', () => {
    const repo = createRepo()
    applyIgnoreMode(repo, 'repo')
    expect(areLoopTroopPathsIgnored(repo)).toBe(true)
  })

  it('is true once the rules are in the local exclude file', () => {
    const repo = createRepo()
    applyIgnoreMode(repo, 'local')
    expect(areLoopTroopPathsIgnored(repo)).toBe(true)
  })

  it('accepts rules the repository already had in its own form', () => {
    const repo = createRepo()
    // Not the rules LoopTroop writes, but they ignore the same paths, which is
    // the whole point of asking git instead of matching text.
    writeFileSync(resolve(repo, '.gitignore'), '.looptroop\n.ticket\n')
    expect(areLoopTroopPathsIgnored(repo)).toBe(true)
  })

  it('notices when a rule is removed after the project was attached', () => {
    const repo = createRepo()
    applyIgnoreMode(repo, 'repo')
    expect(areLoopTroopPathsIgnored(repo)).toBe(true)

    // A colleague rewrites .gitignore and drops one of the two rules.
    writeFileSync(resolve(repo, '.gitignore'), '/.looptroop/\n')

    // Half-ignored is not ignored: the paths git can still see are the ones
    // that end up staged by an `add -A` during execution setup.
    expect(areLoopTroopPathsIgnored(repo)).toBe(false)
  })

  it('reports a skipped project honestly rather than assuming it is fine', () => {
    const repo = createRepo()
    applyIgnoreMode(repo, 'skip')
    expect(areLoopTroopPathsIgnored(repo)).toBe(false)
  })

  it('is false for a directory that is not a repository at all', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'looptroop-ignore-mode-bare-'))
    roots.push(notARepo)
    // Reached via a project folder that has since been replaced or moved.
    expect(areLoopTroopPathsIgnored(notARepo)).toBe(false)
  })
})
