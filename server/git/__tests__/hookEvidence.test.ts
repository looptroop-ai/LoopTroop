import { describe, expect, it } from 'vitest'
import { gitHookEvidenceMatches, normalizeGitHookEvidence, readApprovedGitHookEvidence } from '../hookDiscovery'

const preCommit = { name: 'pre-commit', path: '.husky/pre-commit', source: 'husky', kind: 'hook', runnable: 'yes', managerHint: 'husky' }
const prePush = { name: 'pre-push', path: '.husky/pre-push', source: 'husky', kind: 'hook', runnable: 'no' }

describe('normalizeGitHookEvidence', () => {
  it('sorts by path so discovery order cannot register as drift', () => {
    expect(normalizeGitHookEvidence([prePush, preCommit]).map((entry) => entry.path))
      .toEqual(['.husky/pre-commit', '.husky/pre-push'])
  })

  it('drops entries with no usable identity', () => {
    expect(normalizeGitHookEvidence([preCommit, null, 'text', {}, { name: 'x' }, { path: 'y' }]))
      .toHaveLength(1)
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(normalizeGitHookEvidence(undefined)).toEqual([])
    expect(normalizeGitHookEvidence({ detected: [] })).toEqual([])
  })

  it('normalises an unknown runnable value rather than carrying it through', () => {
    expect(normalizeGitHookEvidence([{ ...preCommit, runnable: 'maybe' }])[0]?.runnable).toBe('unknown')
  })

  it('omits managerHint rather than storing undefined', () => {
    expect(Object.hasOwn(normalizeGitHookEvidence([prePush])[0]!, 'managerHint')).toBe(false)
  })
})

describe('gitHookEvidenceMatches', () => {
  it('treats the same hooks in a different order as unchanged', () => {
    expect(gitHookEvidenceMatches([preCommit, prePush], [prePush, preCommit])).toBe(true)
  })

  it('treats the same hooks with a different key order as unchanged', () => {
    const reordered = { runnable: 'yes', managerHint: 'husky', kind: 'hook', source: 'husky', path: '.husky/pre-commit', name: 'pre-commit' }
    expect(gitHookEvidenceMatches([preCommit], [reordered])).toBe(true)
  })

  it('still reports a genuinely different hook set as changed', () => {
    expect(gitHookEvidenceMatches([preCommit], [preCommit, prePush])).toBe(false)
    expect(gitHookEvidenceMatches([preCommit], [{ ...preCommit, runnable: 'no' }])).toBe(false)
  })

  it('treats a hook listed twice as the same hook', () => {
    // The comparison is a stringify of the normalised list, so a profile that
    // names one hook twice — a hand edit, or two managers reporting the same
    // file — compared unequal to the discovery that found it once, and every
    // integration afterwards reported drift that was not there.
    expect(normalizeGitHookEvidence([preCommit, preCommit]).map((entry) => entry.path))
      .toEqual(['.husky/pre-commit'])
    expect(gitHookEvidenceMatches([preCommit, preCommit], [preCommit])).toBe(true)
    expect(gitHookEvidenceMatches([preCommit, prePush, preCommit], [prePush, preCommit])).toBe(true)
  })

  it('keeps two different hooks that share a path', () => {
    // Deduplication is by path *and* name: a hooks directory reported under one
    // path with two names is two hooks, not one seen twice.
    const sameFileOtherName = { ...preCommit, name: 'pre-merge-commit' }
    expect(normalizeGitHookEvidence([preCommit, sameFileOtherName])).toHaveLength(2)
  })
})

describe('readApprovedGitHookEvidence', () => {
  it('reads either spelling of the profile key', () => {
    expect(readApprovedGitHookEvidence(JSON.stringify({ git_hooks: { detected: [preCommit] } }))).toHaveLength(1)
    expect(readApprovedGitHookEvidence(JSON.stringify({ gitHooks: { detected: [preCommit] } }))).toHaveLength(1)
  })

  it('returns an empty list for an unreadable profile instead of throwing', () => {
    expect(readApprovedGitHookEvidence('not json')).toEqual([])
    expect(readApprovedGitHookEvidence(JSON.stringify({}))).toEqual([])
  })
})
