import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __sessionStateForTests,
  installSessionWatch,
  isSignedOut,
  reportSignedOut,
  subscribeToSessionState,
} from '../sessionState'

/**
 * 2.14 contract: a session the daemon refuses has to become a signed-out screen,
 * not an app whose every request fails silently. The cookie is HttpOnly, so a 401
 * from this origin's API is the only evidence a client can have.
 */
describe('session state', () => {
  const realFetch = window.fetch

  beforeEach(() => {
    __sessionStateForTests.reset()
  })

  afterEach(() => {
    window.fetch = realFetch
    __sessionStateForTests.reset()
  })

  function stubFetch(status: number): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue(new Response(null, { status }))
    window.fetch = mock as unknown as typeof window.fetch
    return mock
  }

  it('starts out believing the session is good', () => {
    expect(isSignedOut()).toBe(false)
  })

  it('tells subscribers the moment the session is gone', () => {
    const listener = vi.fn()
    subscribeToSessionState(listener)

    reportSignedOut()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(isSignedOut()).toBe(true)
  })

  it('notifies once, however often it is told', () => {
    const listener = vi.fn()
    subscribeToSessionState(listener)

    reportSignedOut()
    reportSignedOut()

    // Every failing query reports the same 401; the screen must not re-render for
    // each one.
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn()
    subscribeToSessionState(listener)()

    reportSignedOut()

    expect(listener).not.toHaveBeenCalled()
  })

  describe('watching API responses', () => {
    it('reads a 401 from this origin as the session being over', async () => {
      stubFetch(401)
      installSessionWatch()

      await window.fetch('/api/tickets')

      expect(isSignedOut()).toBe(true)
    })

    it('passes the response through untouched', async () => {
      stubFetch(401)
      installSessionWatch()

      const response = await window.fetch('/api/tickets')

      // A caller that wants to handle its own 401 still can; this only observes.
      expect(response.status).toBe(401)
    })

    it('leaves a successful request alone', async () => {
      stubFetch(200)
      installSessionWatch()

      await window.fetch('/api/tickets')

      expect(isSignedOut()).toBe(false)
    })

    it('ignores a 403, which is a refused action rather than a refused session', async () => {
      stubFetch(403)
      installSessionWatch()

      await window.fetch('/api/tickets')

      expect(isSignedOut()).toBe(false)
    })

    it('ignores a 401 from somewhere that is not this daemon', async () => {
      stubFetch(401)
      installSessionWatch()

      await window.fetch('https://registry.npmjs.org/looptroop/latest')

      expect(isSignedOut()).toBe(false)
    })

    it('ignores a 401 from a page request, which carries no session cookie', async () => {
      stubFetch(401)
      installSessionWatch()

      // The cookie is scoped to /api, so nothing outside it can prove anything.
      await window.fetch('/index.html')

      expect(isSignedOut()).toBe(false)
    })

    /**
     * A nonce is single-use. Opening the same sign-in URL a second time fails the
     * exchange while the cookie the first one bought is still good, so treating
     * that 401 as proof would sign a working session out.
     */
    it('does not read a refused nonce exchange as a refused session', async () => {
      stubFetch(401)
      installSessionWatch()

      await window.fetch('/api/auth/exchange', { method: 'POST' })

      expect(isSignedOut()).toBe(false)
    })

    it('sees a 401 on a Request object as well as a string url', async () => {
      stubFetch(401)
      installSessionWatch()

      await window.fetch(new Request(`${window.location.origin}/api/tickets`))

      expect(isSignedOut()).toBe(true)
    })

    it('wraps fetch once, however many times it is installed', async () => {
      const mock = stubFetch(200)
      installSessionWatch()
      const afterFirst = window.fetch

      installSessionWatch()

      expect(window.fetch).toBe(afterFirst)
      await window.fetch('/api/tickets')
      expect(mock).toHaveBeenCalledTimes(1)
    })
  })
})
