import { describe, expect, it } from 'vitest'
import { serializeSessionCookie } from '../sessionAuth'

describe('session cookie serialization', () => {
  it('keeps local HTTP development usable without Secure', () => {
    const cookie = serializeSessionCookie('session', 60)

    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure')
  })

  it('marks a cookie Secure for an HTTPS public origin', () => {
    expect(serializeSessionCookie('session', 60, { secure: true })).toContain('Secure')
  })
})
