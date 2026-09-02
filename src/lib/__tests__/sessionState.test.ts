import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __sessionStateForTests,
  installSessionWatch,
  isSignedOut,
  probeSessionAfterStreamFailure,
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

/**
 * §9.57: `EventSource.onerror` carries no HTTP status, so a stream refused with
 * 401 looks exactly like a dropped connection. The probe is what tells them
 * apart — and it has to keep telling them apart, because conflating the two
 * either signs people out on a flaky network or never signs them out at all.
 */
describe('probeSessionAfterStreamFailure', () => {
  const realFetch = window.fetch

  beforeEach(() => {
    __sessionStateForTests.reset()
  })

  afterEach(() => {
    window.fetch = realFetch
    __sessionStateForTests.reset()
  })

  it('latches signed-out on a 401', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 })) as unknown as typeof window.fetch

    await probeSessionAfterStreamFailure()

    expect(isSignedOut()).toBe(true)
  })

  it('says nothing on an ordinary server close, which answers 200', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof window.fetch

    await probeSessionAfterStreamFailure()

    expect(isSignedOut()).toBe(false)
  })

  it('says nothing when the daemon is unreachable', async () => {
    // A refused connection is a dead daemon, not an expired session. Signing out
    // here would replace the app with a sign-in screen every time the network
    // hiccupped.
    window.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof window.fetch

    await expect(probeSessionAfterStreamFailure()).resolves.toBeUndefined()
    expect(isSignedOut()).toBe(false)
  })

  it('says nothing on a 500, which is a daemon problem rather than a session one', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof window.fetch

    await probeSessionAfterStreamFailure()

    expect(isSignedOut()).toBe(false)
  })

  it('asks once while a probe is already in flight', async () => {
    let release!: (response: Response) => void
    const mock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    window.fetch = mock as unknown as typeof window.fetch

    const first = probeSessionAfterStreamFailure()
    const second = probeSessionAfterStreamFailure()
    release(new Response(null, { status: 200 }))
    await Promise.all([first, second])

    // A reconnect storm is one question, not twenty.
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('asks an authenticated route, not the unauthenticated health probe', async () => {
    // `/api/health` answers without a session on purpose, so it can never say
    // whether this browser still has one.
    const mock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    window.fetch = mock as unknown as typeof window.fetch

    await probeSessionAfterStreamFailure()

    expect(String(mock.mock.calls[0]?.[0])).toBe('/api/workflow/meta')
  })

  it('does not ask again once the session is already known to be gone', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    window.fetch = mock as unknown as typeof window.fetch
    reportSignedOut()

    await probeSessionAfterStreamFailure()

    expect(mock).not.toHaveBeenCalled()
  })
})
