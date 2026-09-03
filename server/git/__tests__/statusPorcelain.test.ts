import { describe, expect, it } from 'vitest'
import { parseGitStatusPorcelainZ } from '../statusPorcelain'

// The field separator, written as an escape so the file stays greppable.
const NUL = '\u0000'

describe('parseGitStatusPorcelainZ', () => {
  it('reads a plain worktree modification, leading space and all', () => {
    expect(parseGitStatusPorcelainZ(` M src/app.ts${NUL}`)).toEqual([
      { indexStatus: ' ', worktreeStatus: 'M', path: 'src/app.ts' },
    ])
  })

  it('reads a rename as the destination plus the source it left behind', () => {
    // git -z emits the destination first and the original second, which is the
    // opposite of the `R old -> new` shown in the human-readable format.
    const records = parseGitStatusPorcelainZ(`R  new.ts${NUL}old.ts${NUL}`)
    expect(records).toEqual([
      { indexStatus: 'R', worktreeStatus: ' ', path: 'new.ts', originalPath: 'old.ts' },
      { indexStatus: 'D', worktreeStatus: ' ', path: 'old.ts' },
    ])
  })

  it('does not report a copy source as deleted', () => {
    // A copy leaves its source exactly where it was; staging a deletion for it
    // would remove a file the user never touched.
    expect(parseGitStatusPorcelainZ(`C  copy.ts${NUL}source.ts${NUL}`)).toEqual([
      { indexStatus: 'C', worktreeStatus: ' ', path: 'copy.ts', originalPath: 'source.ts' },
    ])
  })

  it('keeps reading records that follow a rename', () => {
    const records = parseGitStatusPorcelainZ(`R  new.ts${NUL}old.ts${NUL}?? extra.ts${NUL}`)
    expect(records.map((record) => record.path)).toEqual(['new.ts', 'old.ts', 'extra.ts'])
  })

  it('tolerates a rename whose source field was truncated', () => {
    expect(parseGitStatusPorcelainZ(`R  new.ts${NUL}`)).toEqual([
      { indexStatus: 'R', worktreeStatus: ' ', path: 'new.ts' },
    ])
  })

  it('ignores empty and too-short records', () => {
    expect(parseGitStatusPorcelainZ(`${NUL}${NUL}M${NUL} M a.ts${NUL}`)).toEqual([
      { indexStatus: ' ', worktreeStatus: 'M', path: 'a.ts' },
    ])
  })

  it('returns nothing for an empty stream', () => {
    expect(parseGitStatusPorcelainZ('')).toEqual([])
  })
})
