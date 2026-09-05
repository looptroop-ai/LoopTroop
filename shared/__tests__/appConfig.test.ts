import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAllowedBackendHost, getBackendOrigin, getBackendPort, getDocsBaseUrl, getFrontendOrigin, getFrontendPort, isLoopbackHost } from '../appConfig'

const ORIGINAL_ENV = {
  LOOPTROOP_BACKEND_PORT: process.env.LOOPTROOP_BACKEND_PORT,
  LOOPTROOP_BACKEND_HOST: process.env.LOOPTROOP_BACKEND_HOST,
  LOOPTROOP_ALLOW_REMOTE_API: process.env.LOOPTROOP_ALLOW_REMOTE_API,
  LOOPTROOP_API_TOKEN: process.env.LOOPTROOP_API_TOKEN,
  LOOPTROOP_DOCS_ORIGIN: process.env.LOOPTROOP_DOCS_ORIGIN,
  LOOPTROOP_FRONTEND_ORIGIN: process.env.LOOPTROOP_FRONTEND_ORIGIN,
  LOOPTROOP_FRONTEND_PORT: process.env.LOOPTROOP_FRONTEND_PORT,
}

describe('appConfig frontend origin', () => {
  afterEach(() => {
    if (ORIGINAL_ENV.LOOPTROOP_BACKEND_PORT === undefined) {
      delete process.env.LOOPTROOP_BACKEND_PORT
    } else {
      process.env.LOOPTROOP_BACKEND_PORT = ORIGINAL_ENV.LOOPTROOP_BACKEND_PORT
    }

    if (ORIGINAL_ENV.LOOPTROOP_BACKEND_HOST === undefined) {
      delete process.env.LOOPTROOP_BACKEND_HOST
    } else {
      process.env.LOOPTROOP_BACKEND_HOST = ORIGINAL_ENV.LOOPTROOP_BACKEND_HOST
    }

    if (ORIGINAL_ENV.LOOPTROOP_ALLOW_REMOTE_API === undefined) {
      delete process.env.LOOPTROOP_ALLOW_REMOTE_API
    } else {
      process.env.LOOPTROOP_ALLOW_REMOTE_API = ORIGINAL_ENV.LOOPTROOP_ALLOW_REMOTE_API
    }

    if (ORIGINAL_ENV.LOOPTROOP_API_TOKEN === undefined) {
      delete process.env.LOOPTROOP_API_TOKEN
    } else {
      process.env.LOOPTROOP_API_TOKEN = ORIGINAL_ENV.LOOPTROOP_API_TOKEN
    }

    if (ORIGINAL_ENV.LOOPTROOP_DOCS_ORIGIN === undefined) {
      delete process.env.LOOPTROOP_DOCS_ORIGIN
    } else {
      process.env.LOOPTROOP_DOCS_ORIGIN = ORIGINAL_ENV.LOOPTROOP_DOCS_ORIGIN
    }

    if (ORIGINAL_ENV.LOOPTROOP_FRONTEND_ORIGIN === undefined) {
      delete process.env.LOOPTROOP_FRONTEND_ORIGIN
    } else {
      process.env.LOOPTROOP_FRONTEND_ORIGIN = ORIGINAL_ENV.LOOPTROOP_FRONTEND_ORIGIN
    }

    if (ORIGINAL_ENV.LOOPTROOP_FRONTEND_PORT === undefined) {
      delete process.env.LOOPTROOP_FRONTEND_PORT
    } else {
      process.env.LOOPTROOP_FRONTEND_PORT = ORIGINAL_ENV.LOOPTROOP_FRONTEND_PORT
    }
    vi.restoreAllMocks()
  })

  it('derives the default frontend origin from LOOPTROOP_FRONTEND_PORT', () => {
    delete process.env.LOOPTROOP_FRONTEND_ORIGIN
    process.env.LOOPTROOP_FRONTEND_PORT = '6199'

    expect(getFrontendOrigin()).toBe('http://localhost:6199')
  })

  it('includes the VitePress base path in browser-facing documentation URLs', () => {
    delete process.env.LOOPTROOP_DOCS_ORIGIN
    // Installed users have no local docs server, so the hosted site is the default.
    expect(getDocsBaseUrl()).toBe('https://www.looptroop.ovh/docs')

    process.env.LOOPTROOP_DOCS_ORIGIN = 'http://devbox.local:7000/'
    expect(getDocsBaseUrl()).toBe('http://devbox.local:7000/docs')

    process.env.LOOPTROOP_DOCS_ORIGIN = 'http://devbox.local:7000/docs'
    expect(getDocsBaseUrl()).toBe('http://devbox.local:7000/docs')
  })

  it('keeps explicit LOOPTROOP_FRONTEND_ORIGIN validation and falls back to the derived port origin', () => {
    delete process.env.LOOPTROOP_FRONTEND_ORIGIN
    process.env.LOOPTROOP_FRONTEND_PORT = '6201'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    process.env.LOOPTROOP_FRONTEND_ORIGIN = 'not a url'

    expect(getFrontendOrigin()).toBe('http://localhost:6201')
    expect(warnSpy).toHaveBeenCalledWith(
      '[config] Invalid LOOPTROOP_FRONTEND_ORIGIN: not a url. Falling back to http://localhost:6201.',
    )
  })

  it('rejects configured ports outside the valid TCP range', () => {
    process.env.LOOPTROOP_FRONTEND_PORT = '0'
    process.env.LOOPTROOP_BACKEND_PORT = '-1'

    expect(getFrontendPort()).toBe(5173)
    expect(getBackendPort()).toBe(3000)
  })

  it('rejects malformed port values instead of partially parsing them', () => {
    process.env.LOOPTROOP_FRONTEND_PORT = '5173abc'
    process.env.LOOPTROOP_BACKEND_PORT = '300e0'

    expect(getFrontendPort()).toBe(5173)
    expect(getBackendPort()).toBe(3000)
  })

  it('defaults backend origin to loopback and blocks remote binds without opt-in', () => {
    delete process.env.LOOPTROOP_BACKEND_HOST
    process.env.LOOPTROOP_BACKEND_PORT = '3005'
    expect(getBackendOrigin()).toBe('http://127.0.0.1:3005')
    expect(getAllowedBackendHost()).toBe('127.0.0.1')

    process.env.LOOPTROOP_BACKEND_HOST = '0.0.0.0'
    expect(() => getAllowedBackendHost()).toThrow('Refusing to bind LoopTroop API')

    process.env.LOOPTROOP_ALLOW_REMOTE_API = '1'
    // Still requires a token when binding to a non-loopback host.
    expect(() => getAllowedBackendHost()).toThrow('LOOPTROOP_API_TOKEN must be set')

    process.env.LOOPTROOP_API_TOKEN = 'secret-token'
    expect(getAllowedBackendHost()).toBe('0.0.0.0')
  })

  it('allows non-loopback bind when both LOOPTROOP_ALLOW_REMOTE_API and LOOPTROOP_API_TOKEN are set', () => {
    process.env.LOOPTROOP_BACKEND_HOST = '0.0.0.0'
    process.env.LOOPTROOP_ALLOW_REMOTE_API = '1'
    process.env.LOOPTROOP_API_TOKEN = 'my-token'
    expect(getAllowedBackendHost()).toBe('0.0.0.0')
  })
})

describe('isLoopbackHost', () => {
  it('accepts the loopback names and addresses', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('rejects a hostname that merely starts with 127.', () => {
    // `startsWith('127.')` accepted this, and it resolves to whatever its owner
    // points it at — so a name under someone else's control passed the check
    // the host guard depends on.
    expect(isLoopbackHost('127.attacker.example')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.test')).toBe(false)
  })

  it('rejects an address that is not a valid dotted quad', () => {
    for (const host of ['127.999.0.1', '127.0.0', '127.0.0.1.2', '127.0.0.256', '127.0.0.01', '127.', '127.0.0.x']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  it('rejects other private and public addresses', () => {
    for (const host of ['0.0.0.0', '10.0.0.1', '192.168.1.1', '128.0.0.1', 'example.com']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})
