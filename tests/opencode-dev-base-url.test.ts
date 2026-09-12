import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { getServeHostname, parseLocalPortFromUrl, resolveOpenCodeBaseUrl } from '../scripts/opencode-dev-base-url'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('resolveOpenCodeBaseUrl', () => {
  it('authenticates a local provider directly but never follows its redirect', async () => {
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'opencode')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'local-test-password')
    const authorization = `Basic ${Buffer.from('opencode:local-test-password').toString('base64')}`
    let redirect = false
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      if (req.headers.authorization !== authorization) {
        res.writeHead(401).end()
      } else if (redirect && req.url === '/provider') {
        res.writeHead(302, { Location: '/redirect-target' }).end()
      } else {
        res.writeHead(200).end('{}')
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test listener')
      const options = {
        requestedBaseUrl: `http://127.0.0.1:${address.port}`,
        hasExplicitBaseUrl: true,
        deps: {
          canConnect: async () => true,
          inspectPortOccupants: () => ({ port: address.port, occupants: [], rawSocketSnapshot: null }),
        },
      }
      expect((await resolveOpenCodeBaseUrl(options)).status).toBe('already-running')
      redirect = true
      await expect(resolveOpenCodeBaseUrl(options)).rejects.toThrow('occupied by a non-OpenCode process')
      expect(requests).toEqual(['/provider', '/provider'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it.each([
    ['http://[::1]:4096', '::1'],
    ['http://[::ffff:127.0.0.2]:4096', '::ffff:7f00:2'],
    ['http://127.0.0.2:4096', '127.0.0.2'],
    ['http://[::]:4096', '::'],
  ])('probes %s with bare socket hosts and preserves URL brackets on fallback', async (requestedBaseUrl, hostname) => {
    const canConnect = vi.fn(async () => true)
    const canListen = vi.fn(async () => true)
    const result = await resolveOpenCodeBaseUrl({
      requestedBaseUrl,
      hasExplicitBaseUrl: false,
      deps: {
        isOpenCodeResponding: async () => false,
        canConnect,
        canListen,
        inspectPortOccupants: () => ({ port: 4096, occupants: [], rawSocketSnapshot: null }),
      },
    })

    const fallback = new URL(requestedBaseUrl)
    fallback.port = '4097'
    expect(result.status).toBe('ready-to-start')
    expect(result.baseUrl).toBe(fallback.origin)
    expect(canConnect).toHaveBeenCalledWith(hostname, 4096)
    expect(canListen).toHaveBeenCalledWith(hostname, 4097)
    expect(getServeHostname(fallback)).toBe(hostname)
  })

  it.each([
    ['http://[::1]:4096', 'http://[::1]:4096/provider'],
    ['http://[::ffff:127.0.0.2]:4096', 'http://[::ffff:7f00:2]:4096/provider'],
  ])('reuses %s through a valid bracketed provider URL', async (requestedBaseUrl, providerUrl) => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenCodeBaseUrl({ requestedBaseUrl, hasExplicitBaseUrl: true })

    expect(result.status).toBe('already-running')
    expect(fetchMock).toHaveBeenCalledWith(providerUrl, expect.any(Object))
  })

  it('probes the IPv6 loopback when a wildcard listener cannot be reached at ::', async () => {
    const isOpenCodeResponding = vi.fn(async (_url: URL, hostname: string) => hostname === '::1')
    const result = await resolveOpenCodeBaseUrl({
      requestedBaseUrl: 'http://[::]:4096',
      hasExplicitBaseUrl: true,
      deps: { isOpenCodeResponding },
    })
    expect(result.status).toBe('already-running')
    expect(isOpenCodeResponding.mock.calls.map((call) => call[1])).toEqual(['::', '::1'])
  })

  it('reuses an already running OpenCode instance on the requested port', async () => {
    const result = await resolveOpenCodeBaseUrl({
      requestedBaseUrl: 'http://127.0.0.1:4096',
      hasExplicitBaseUrl: false,
      deps: {
        isOpenCodeResponding: async () => true,
        canConnect: async () => false,
        canListen: async () => true,
      },
    })

    expect(result).toEqual({
      baseUrl: 'http://127.0.0.1:4096',
      note: 'OpenCode already reachable at http://127.0.0.1:4096; reusing it.',
      status: 'already-running',
    })
  })

  it('falls back to the next free port when the default port is occupied by another app', async () => {
    const result = await resolveOpenCodeBaseUrl({
      requestedBaseUrl: 'http://127.0.0.1:4096',
      hasExplicitBaseUrl: false,
      deps: {
        isOpenCodeResponding: async () => false,
        canConnect: async (_hostname, port) => port === 4096,
        canListen: async (_hostname, port) => port === 4097,
        inspectPortOccupants: () => ({
          port: 4096,
          occupants: [{
            pid: 3251,
            ppid: 3058,
            program: 'kilo',
            command: 'kilo serve --port 0',
            cwd: '/mnt/d/tools/kilo',
            source: 'lsof',
          }],
          rawSocketSnapshot: null,
        }),
      },
    })

    expect(result).toEqual({
      baseUrl: 'http://127.0.0.1:4097',
      note: 'Port 4096 is occupied on 127.0.0.1; using http://127.0.0.1:4097 for OpenCode instead. Occupant: kilo (pid 3251, cmd: kilo serve --port 0, cwd: /mnt/d/tools/kilo).',
      status: 'ready-to-start',
    })
  })

  it('rejects an explicit conflicting base URL instead of silently moving it', async () => {
    await expect(resolveOpenCodeBaseUrl({
      requestedBaseUrl: 'http://127.0.0.1:5001',
      hasExplicitBaseUrl: true,
      deps: {
        isOpenCodeResponding: async () => false,
        canConnect: async () => true,
        canListen: async () => true,
        inspectPortOccupants: () => ({
          port: 5001,
          occupants: [{
            pid: 812,
            ppid: 1,
            program: 'node',
            command: 'node /tmp/server.js',
            cwd: '/mnt/d/services/api',
            source: 'ss',
          }],
          rawSocketSnapshot: null,
        }),
      },
    })).rejects.toThrow(
      'Configured OpenCode URL http://127.0.0.1:5001 is occupied by a non-OpenCode process on 127.0.0.1. Occupant: node (pid 812, cmd: node /tmp/server.js, cwd: /mnt/d/services/api). Choose a different LOOPTROOP_OPENCODE_BASE_URL before running `npm run dev`.',
    )
  })

  it('keeps the generic error wording when no occupant details can be discovered', async () => {
    await expect(resolveOpenCodeBaseUrl({
      requestedBaseUrl: 'http://127.0.0.1:4096',
      hasExplicitBaseUrl: false,
      deps: {
        isOpenCodeResponding: async () => false,
        canConnect: async () => true,
        canListen: async () => false,
        inspectPortOccupants: () => ({
          port: 4096,
          occupants: [],
          rawSocketSnapshot: null,
        }),
      },
    })).rejects.toThrow(
      'Default OpenCode port 4096 is occupied by another process on 127.0.0.1 and no free fallback port was found.',
    )
  })

  it.each(['example.com', '127.attacker.example', '[::ffff:192.0.2.1]', '[2001:db8::1]'])('skips local startup for remote host %s', async (host) => {
    const canConnect = vi.fn(async () => false)
    const result = await resolveOpenCodeBaseUrl({
      requestedBaseUrl: `https://${host}/opencode/`,
      hasExplicitBaseUrl: true,
      deps: { canConnect },
    })

    const baseUrl = `https://${new URL(`https://${host}`).hostname}/opencode`
    expect(result).toEqual({
      baseUrl,
      note: `Using remote OpenCode at ${baseUrl}.`,
      status: 'remote',
    })
    expect(canConnect).not.toHaveBeenCalled()
  })
})

describe('parseLocalPortFromUrl', () => {
  it.each([
    ['http://[::1]:4096', 4096],
    ['http://[::ffff:127.0.0.2]:4097', 4097],
    ['http://127.0.0.2:4098', 4098],
    ['http://localhost', 80],
    ['https://[::1]', 443],
    ['http://0.0.0.0:4096', 4096],
    ['http://[0:0:0:0:0:0:0:0]:4096', 4096],
    ['http://127.0.0.1:0', 0],
    ['http://127.attacker.example:4096', null],
    ['http://[::ffff:192.0.2.1]:4096', null],
    ['http://example.com', null],
    ['not a URL', null],
  ])('extracts only local ports from %s', (url, expected) => {
    expect(parseLocalPortFromUrl(url)).toBe(expected)
  })
})
