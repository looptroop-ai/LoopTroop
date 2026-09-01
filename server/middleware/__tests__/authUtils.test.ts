import { describe, expect, it } from 'vitest'
import { API_TOKEN_HEADER, constantTimeEquals, getBearerToken } from '../authUtils'

describe('getBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer\tabc', 'abc'],
    ['Bearer  abc  ', 'abc'],
    ['  Bearer abc  ', 'abc'],
    ['Bearer  \t  tok', 'tok'],
    ['Bearer a b c', 'a b c'],
    // Trailing whitespace goes before matching, so this is a plain token.
    ['Bearer abc\n', 'abc'],
  ])('reads the token from %j', (header, expected) => {
    expect(getBearerToken(header)).toBe(expected)
  })

  it.each([
    [undefined],
    [''],
    ['Bearer'],
    ['Bearer '],
    ['Bearer   '],
    ['Bearerabc'],
    ['BearerX abc'],
    ['Basic abc'],
    // `.` does not cross a newline, so a value that continues past one is not
    // a token — only a trailing one is trimmed away.
    ['Bearer a\nb'],
    ['Bearer \n'],
  ])('returns null for %j', (header) => {
    expect(getBearerToken(header)).toBeNull()
  })

  it('does not backtrack quadratically on a header built to make it', () => {
    // `\s+(.+)` was ambiguous — both halves match a space — so a header of
    // `Bearer`, many spaces, then a value broken by a newline took 320 ms at
    // 16,000 spaces and grew with the square of the length, on a value any
    // client can send to the code that decides whether it is authorised.
    //
    // The trailing `B` matters: the value is trimmed before matching, so a
    // hostile input has to end in a non-space to survive that. The first
    // attempt at this test forgot, got trimmed down to `Bearer`, and passed
    // against the very regex it was written to catch.
    const hostile = (spaces: number) => `Bearer${' '.repeat(spaces)}A\nB`

    const started = process.hrtime.bigint()
    expect(getBearerToken(hostile(16_000))).toBeNull()
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // Linear matching is a fraction of a millisecond here against 320 ms
    // quadratic. The bound is loose so a busy runner cannot make it flaky,
    // and the two are still three orders of magnitude apart.
    expect(elapsedMs).toBeLessThan(100)
  })
})

describe('constantTimeEquals', () => {
  it('accepts an exact match', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true)
  })

  it.each([
    ['token', 'tokeN'],
    ['token', 'token-longer'],
    ['token', ''],
    ['', 'token'],
  ])('rejects %j against %j', (left, right) => {
    expect(constantTimeEquals(left, right)).toBe(false)
  })

  it('treats two empty strings as equal', () => {
    expect(constantTimeEquals('', '')).toBe(true)
  })
})

describe('API_TOKEN_HEADER', () => {
  it('is the lowercase header name clients send', () => {
    // Scripts and the SPA both send this; renaming it breaks them silently.
    expect(API_TOKEN_HEADER).toBe('x-looptroop-token')
  })
})
