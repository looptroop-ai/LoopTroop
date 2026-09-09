import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO_SCOPE_PATHSPECS } from '../../../git/pathspecs'

const runGitSyncMock = vi.fn()

vi.mock('../../../git/runCommand', () => ({
  runGitSync: (...args: unknown[]) => runGitSyncMock(...args),
}))

const { focusedDiffMetadata } = await import('../focusedDiff')

const DIFF_METADATA_LIMIT = 80_000
const UNAVAILABLE = 'Focused diff metadata unavailable.'
const EMPTY = 'No candidate file metadata was reported.'

function ok(stdout: string) {
  return { ok: true, status: 0, signal: null, timedOut: false, stdout, stderr: '' }
}

function failed(errorDetail: string) {
  return { ok: false, status: 128, signal: null, timedOut: false, stdout: '', stderr: '', errorDetail }
}

/** Answers the merge-base call and then the diff call, in that order. */
function stubGit(mergeBase: ReturnType<typeof ok>, diff?: ReturnType<typeof ok>) {
  runGitSyncMock.mockReturnValueOnce(mergeBase)
  if (diff) runGitSyncMock.mockReturnValueOnce(diff)
}

/**
 * `focusedDiffMetadata` is one implementation shared by the Manual QA checklist
 * generator and the fix-bead planner, which used to hold a copy each. The
 * dedup was made on the source text matching; these cases assert the behaviour
 * both callers depend on — that a git failure degrades to a sentence instead of
 * throwing into a phase, that an empty diff is distinguishable from a failed
 * one, and that the output cannot grow past the prompt budget.
 */
describe('focusedDiffMetadata', () => {
  beforeEach(() => {
    runGitSyncMock.mockReset()
  })

  it('asks for the ticket\'s own changes since it branched, scoped to the repository', () => {
    stubGit(ok('abc123'), ok('M\tsrc/app.ts'))

    focusedDiffMetadata('/worktree', 'main')

    expect(runGitSyncMock).toHaveBeenNthCalledWith(1, '/worktree', ['merge-base', 'HEAD', 'main'])
    expect(runGitSyncMock).toHaveBeenNthCalledWith(2, '/worktree', [
      'diff', '--name-status', '--stat=120,80', 'abc123..HEAD',
      '--', ...REPO_SCOPE_PATHSPECS,
    ])
  })

  it.each([
    ['the merge base cannot be resolved', () => stubGit(failed('unknown revision'))],
    ['the merge base comes back empty', () => stubGit(ok(''))],
    ['the diff itself fails', () => stubGit(ok('abc123'), failed('bad object'))],
  ])('reports the metadata unavailable when %s', (_, stub) => {
    stub()

    expect(focusedDiffMetadata('/worktree', 'main')).toBe(UNAVAILABLE)
  })

  it('does not run the diff at all once the merge base has failed', () => {
    stubGit(failed('unknown revision'))

    focusedDiffMetadata('/worktree', 'main')

    expect(runGitSyncMock).toHaveBeenCalledTimes(1)
  })

  it('distinguishes an empty diff from a failed one', () => {
    stubGit(ok('abc123'), ok(''))

    // Both are a prompt-safe sentence, but they say different things: a
    // checklist generated from "nothing changed" is a different artifact from
    // one generated blind.
    expect(focusedDiffMetadata('/worktree', 'main')).toBe(EMPTY)
    expect(EMPTY).not.toBe(UNAVAILABLE)
  })

  it('truncates a diff larger than the prompt budget', () => {
    const oversized = 'M\tsrc/app.ts\n'.repeat(20_000)
    expect(oversized.length).toBeGreaterThan(DIFF_METADATA_LIMIT)
    stubGit(ok('abc123'), ok(oversized))

    const metadata = focusedDiffMetadata('/worktree', 'main')

    expect(metadata).toHaveLength(DIFF_METADATA_LIMIT)
    expect(metadata).toBe(oversized.slice(0, DIFF_METADATA_LIMIT))
  })

  it('passes a diff at exactly the budget through whole', () => {
    const exact = 'x'.repeat(DIFF_METADATA_LIMIT)
    stubGit(ok('abc123'), ok(exact))

    expect(focusedDiffMetadata('/worktree', 'main')).toBe(exact)
  })

  it('keeps the reported file order the diff gave it', () => {
    const reordered = ['M\tz.ts', 'A\ta.ts', 'D\tm.ts'].join('\n')
    stubGit(ok('abc123'), ok(reordered))

    expect(focusedDiffMetadata('/worktree', 'main')).toBe(reordered)
  })
})
