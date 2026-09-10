import { describe, expect, it } from 'vitest'
import { classifyWorktreePath } from '../worktreeChanges'

/**
 * These cases used to live in `server/phases/execution/__tests__/gitOps.test.ts`
 * and in a `server/validation/` tree of one file, both of which called
 * `isAllowedFile` — a boolean wrapper over this function that only tests used.
 * Asserting the category itself says *why* a path is kept out of a bead commit,
 * which is the distinction the commit flow and the noise warning both read.
 *
 * `untracked` is passed explicitly throughout: the deleted wrapper defaulted it
 * to `true`, `classifyWorktreePath` defaults it to `false`, and the generated
 * noise rules only apply when it is on.
 */
describe('classifyWorktreePath', () => {
  it('commits language-agnostic project files, with no extension allowlist', () => {
    for (const path of [
      'src/app.ts',
      'src/style.css',
      'src/Program.cs',
      'package.json',
      'Makefile',
      'image.png',
      'data.bin',
      'tsconfig.json',
      'issues.jsonl',
      'reports/issues.jsonl',
    ]) {
      expect(classifyWorktreePath(path, { untracked: true })).toEqual({ category: 'committable' })
    }
  })

  it('excludes every LoopTroop path, artifacts and runtime state alike', () => {
    for (const path of [
      '.ticket/interview.yaml',
      '.ticket/prd.yaml',
      '.ticket/codebase-map.yaml',
      '.ticket/beads/master/.beads/issues.jsonl',
      '.ticket/meta/ticket.meta.json',
      '.ticket/ui/artifact-companions/beads_expanded.json',
      '.ticket/runtime/state.json',
      '.ticket/runtime/session/abc',
      '.ticket/locks/main.lock',
      '.ticket/sessions/abc.json',
      '.ticket/streams/live.json',
      '.ticket/tmp/scratch.ts',
      '.looptroop/config.json',
    ]) {
      expect(classifyWorktreePath(path, { untracked: true })).toEqual({ category: 'looptroopExcluded' })
    }
  })

  it('names the pattern that made a path generated noise', () => {
    expect(classifyWorktreePath('node_modules/foo/bar.js', { untracked: true }))
      .toEqual({ category: 'generatedNoise', generatedNoisePattern: 'node_modules/' })
    expect(classifyWorktreePath('dist/bundle.js', { untracked: true }))
      .toEqual({ category: 'generatedNoise', generatedNoisePattern: 'dist/' })
    expect(classifyWorktreePath('.env', { untracked: true }))
      .toEqual({ category: 'generatedNoise', generatedNoisePattern: '.env' })
    expect(classifyWorktreePath('.env.local', { untracked: true }))
      .toEqual({ category: 'generatedNoise', generatedNoisePattern: '.env.*' })
  })

  it('keeps the dotenv templates that belong in the repository', () => {
    expect(classifyWorktreePath('.env.example', { untracked: true })).toEqual({ category: 'committable' })
    expect(classifyWorktreePath('.env.sample', { untracked: true })).toEqual({ category: 'committable' })
  })

  it('applies the generated noise rules to untracked paths only', () => {
    for (const path of ['dist/bundle.js', 'node_modules/foo/bar.js', '.env']) {
      expect(classifyWorktreePath(path, { untracked: false })).toEqual({ category: 'committable' })
      expect(classifyWorktreePath(path)).toEqual({ category: 'committable' })
    }
  })

  it('excludes the legacy execution setup cache whether or not the path is tracked', () => {
    expect(classifyWorktreePath('.cache/project-tooling/go/src/runtime.go', { untracked: true }))
      .toEqual({ category: 'setupExcluded' })
    expect(classifyWorktreePath('.cache/project-tooling/go/src/runtime.go', { untracked: false }))
      .toEqual({ category: 'setupExcluded' })
  })

  it('matches a cache root on segment boundaries, not on a string prefix', () => {
    // `.cache/project-tooling-extra` is not inside `.cache/project-tooling`, so
    // it is only noise, and only while untracked.
    expect(classifyWorktreePath('.cache/project-tooling-extra/go/src/runtime.go', { untracked: true }))
      .toEqual({ category: 'generatedNoise', generatedNoisePattern: '.cache/' })
    expect(classifyWorktreePath('.cache/project-tooling-extra/go/src/runtime.go', { untracked: false }))
      .toEqual({ category: 'committable' })
  })

  it('excludes the setup roots the caller supplies, on top of the legacy ones', () => {
    const setupExcludedRoots = ['.ticket/runtime/execution-setup/tool-cache']

    expect(classifyWorktreePath('.ticket/runtime/execution-setup/tool-cache/go/src/runtime.go', {
      setupExcludedRoots,
      untracked: true,
      // `.ticket` wins: the caller's root is under it, and LoopTroop paths are
      // classified first.
    })).toEqual({ category: 'looptroopExcluded' })

    expect(classifyWorktreePath('vendor/tool-cache/go/src/runtime.go', {
      setupExcludedRoots: ['vendor/tool-cache'],
      untracked: true,
    })).toEqual({ category: 'setupExcluded' })

    expect(classifyWorktreePath('src/app.ts', { setupExcludedRoots, untracked: true }))
      .toEqual({ category: 'committable' })
  })
})
