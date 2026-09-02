import { describe, it, expect } from 'vitest'
import { apiProjectPath, apiTicketPath } from '../apiPaths'

describe('apiTicketPath', () => {
  it('encodes the colon that every real ticket id carries', () => {
    // Ids are `<projectId>:<shortname>-<n>`. The colon is what makes this the
    // common case rather than an edge case.
    expect(apiTicketPath('1:TEST-1')).toBe('/api/tickets/1%3ATEST-1')
  })

  it('keeps a slash inside the id instead of letting it choose another route', () => {
    // `FEAT/123` interpolated raw asks the server for
    // `/api/tickets/FEAT/123/beads`, which is a different route with different
    // parameters — the failure this helper exists to prevent.
    expect(apiTicketPath('FEAT/123', 'beads')).toBe('/api/tickets/FEAT%2F123/beads')
  })

  it('encodes every trailing segment, not only the id', () => {
    expect(apiTicketPath('t1', 'phases', 'WAITING PRD', 'attempts'))
      .toBe('/api/tickets/t1/phases/WAITING%20PRD/attempts')
  })

  it('accepts numeric segments, which version numbers are', () => {
    expect(apiTicketPath('t1', 'manual-qa', 'versions', 3)).toBe('/api/tickets/t1/manual-qa/versions/3')
  })

  it('stops a question mark in an id from truncating the path', () => {
    expect(apiTicketPath('a?b=c')).toBe('/api/tickets/a%3Fb%3Dc')
  })
})

describe('apiProjectPath', () => {
  it('encodes the id and every segment', () => {
    expect(apiProjectPath(7, 'worktrees', 'size')).toBe('/api/projects/7/worktrees/size')
    expect(apiProjectPath('a/b')).toBe('/api/projects/a%2Fb')
  })
})
