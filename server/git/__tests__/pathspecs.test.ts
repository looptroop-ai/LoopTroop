import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandSync } from '../runCommand'
import { literalPathspec, LOOPTROOP_EXCLUDE_PATHSPECS, REPO_SCOPE_PATHSPECS } from '../pathspecs'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = runCommandSync('git', args, { cwd, log: false })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.errorDetail}`)
  return result.stdout
}

/**
 * A repository holding the filename that started this: `src/[id].tsx` is an
 * ordinary dynamic-route name, and as a pathspec it is a character class that
 * matches the `src/i.tsx` sitting beside it.
 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-pathspecs-'))
  roots.push(root)
  git(root, 'init', '--initial-branch', 'main')
  git(root, 'config', 'user.name', 'LoopTroop')
  git(root, 'config', 'user.email', 'looptroop@local')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', '[id].tsx'), 'route\n')
  writeFileSync(join(root, 'src', 'i.tsx'), 'sibling\n')
  git(root, 'add', '--', '.')
  git(root, 'commit', '-m', 'initial')
  return root
}

/**
 * The staged set by name.
 *
 * Deliberately not `git status --porcelain`: whether a path stages as `A` or
 * `M` depends on what the *setup* left tracked, and git 2.47 and 2.55 disagreed
 * about that here. The question this file asks is only ever "which paths did
 * git stage", so ask exactly that.
 */
function stagedPaths(root: string): string[] {
  return git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('literalPathspec', () => {
  it('prefixes the path with the magic that turns off globbing', () => {
    expect(literalPathspec('src/[id].tsx')).toBe(':(literal)src/[id].tsx')
  })

  it('stops git staging a file it was never asked to touch', () => {
    const root = makeRepo()
    // The shape that makes this silent rather than loud: the named file is gone
    // from the worktree *and* the index, so nothing matches it literally and the
    // glob is free to match the neighbour instead.
    unlinkSync(join(root, 'src', '[id].tsx'))
    // The setup names the file literally too. It did not at first, and git 2.55
    // duly matched the neighbour and untracked that as well — this test's own
    // fixture walked into the bug it exists to describe, and only on the git CI
    // runs (2.55) and not the one here (2.47).
    git(root, 'rm', '--quiet', '--cached', '--', literalPathspec('src/[id].tsx'))
    git(root, 'commit', '-m', 'drop the route')
    writeFileSync(join(root, 'src', 'i.tsx'), 'edited by someone else\n')

    // Bare: exit zero, and `src/i.tsx` staged — a file the caller never named.
    git(root, 'add', '-v', '--', 'src/[id].tsx')
    expect(stagedPaths(root)).toContain('src/i.tsx')

    git(root, 'reset', '--quiet')

    // Literal: the pathspec matches nothing, so git says so instead of
    // improvising. A loud failure is the point — the caller asked for a file
    // that is not there.
    const literal = runCommandSync('git', ['add', '-v', '--', literalPathspec('src/[id].tsx')], { cwd: root, log: false })
    expect(literal.ok).toBe(false)
    expect(stagedPaths(root)).not.toContain('src/i.tsx')
  })

  it('still names the file it is given when that file does exist', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', '[id].tsx'), 'edited\n')
    writeFileSync(join(root, 'src', 'i.tsx'), 'also edited\n')

    git(root, 'add', '-v', '--', literalPathspec('src/[id].tsx'))

    // Exactly one path staged, and it is the one that was named.
    expect(stagedPaths(root)).toEqual(['src/[id].tsx'])
  })

  it('keeps the control directories excluded as patterns, not names', () => {
    // The exclusions are the one thing here that is meant to be a pattern, so
    // they must not be wrapped: `:(top,exclude)` already carries its own magic.
    expect(REPO_SCOPE_PATHSPECS[0]).toBe('.')
    for (const spec of LOOPTROOP_EXCLUDE_PATHSPECS) {
      expect(spec.startsWith(':(top,exclude)')).toBe(true)
      expect(spec.startsWith(':(literal)')).toBe(false)
    }
  })
})
