import { describe, expect, it } from 'vitest'
import { parseNodeFloor } from '../shared/nodeFloor'
import {
  judgeFeeds,
  newestVersion,
  readChocolatey,
  readHomebrew,
  readScoop,
  readWinget,
} from '../scripts/check-node-feeds.ts'

/**
 * The network half of `scripts/check-node-feeds.ts` runs only on Renovate's
 * floor pull requests. What is tested here is everything it decides with: how
 * each feed's answer is read, and what counts as offering the floor.
 */
describe('reading the Node feeds', () => {
  it('orders versions as numbers, so 24.10.0 is newer than 24.9.0', () => {
    expect(newestVersion(['24.9.0', '24.10.0', '24.2.0'])).toBe('24.10.0')
  })

  it('ignores whatever in a listing is not a version', () => {
    expect(newestVersion(['.validation', '24.19.0', 'README.md'])).toBe('24.19.0')
    expect(newestVersion([])).toBeNull()
  })

  it('reads the newest version from a winget manifest directory listing', () => {
    expect(readWinget([{ name: '24.18.1' }, { name: '24.19.0' }, { name: '22.20.0' }])).toBe('24.19.0')
    expect(readWinget({ message: 'API rate limit exceeded' })).toBeNull()
  })

  it('reads Chocolatey, Scoop and Homebrew answers', () => {
    expect(readChocolatey('<entry><m:properties><d:Version>24.21.0</d:Version></m:properties></entry>')).toBe('24.21.0')
    expect(readChocolatey('<feed></feed>')).toBeNull()
    expect(readScoop({ version: '24.21.0' })).toBe('24.21.0')
    expect(readScoop(null)).toBeNull()
    expect(readHomebrew({ versions: { stable: '24.21.0' } })).toBe('24.21.0')
    expect(readHomebrew({})).toBeNull()
  })
})

describe('judging the feeds against the floor', () => {
  const offering = (winget: string | null) => [
    { feed: 'winget', offers: winget, error: winget === null ? 'HTTP 403' : undefined },
    { feed: 'Chocolatey', offers: '24.21.0' },
    { feed: 'Scoop', offers: '24.21.0' },
  ]

  /** The incident: every feed but winget had the Node the floor demanded. */
  it('refuses the floor #135 was: above what winget offered', () => {
    expect(judgeFeeds(parseNodeFloor('>=24.21.0'), offering('24.19.0'))).toEqual([
      'winget: offers 24.19.0, below the floor 24.21.0',
    ])
  })

  it('accepts a floor every feed already offers, including exactly', () => {
    expect(judgeFeeds(parseNodeFloor('>=24.18.0'), offering('24.19.0'))).toEqual([])
    expect(judgeFeeds(parseNodeFloor('>=24.19.0'), offering('24.19.0'))).toEqual([])
  })

  it('treats a feed it could not read as not offering the floor', () => {
    expect(judgeFeeds(parseNodeFloor('>=24.18.0'), offering(null))).toEqual([
      'winget: could not be read (HTTP 403)',
    ])
  })
})
