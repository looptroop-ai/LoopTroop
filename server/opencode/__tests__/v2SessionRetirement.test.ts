import { describe, expect, it } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import { V2OpenCodeTransport } from '../v2Transport'

type Node = { id: string; directory: string; parent?: string; shellID?: string; tool?: string }
type Shell = { id: string; owner: string; directory: string; status: string }

function fixture(options: {
  nodes?: Node[]
  shells?: Shell[]
  fail?: (method: string, url: URL) => Response | undefined
  keepRunning?: boolean
} = {}) {
  const nodes = options.nodes ?? [
    { id: 'root', directory: '/worktree', shellID: 'root-shell' },
    { id: 'child', parent: 'root', directory: '/child-worktree', shellID: 'child-shell', tool: 'bash' },
  ]
  const shells = options.shells ?? nodes.flatMap(node => node.shellID
    ? [{ id: node.shellID, owner: node.id, directory: node.directory, status: 'running' }]
    : [])
  const permissions = new Map<string, unknown>()
  const requests: Array<{ method: string; url: URL; body?: unknown }> = []
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  const transport = new V2OpenCodeTransport('http://opencode.test', {
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { permissions?: unknown } : undefined
      requests.push({ method, url, body })
      const failure = options.fail?.(method, url)
      if (failure) return failure
      if (url.pathname === '/api/session') return json({
        data: nodes.filter(node => node.parent === url.searchParams.get('parentID'))
          .map(node => ({ id: node.id, location: { directory: node.directory } })),
        cursor: {},
      })
      if (url.pathname === '/api/shell') return json({
        location: { directory: url.searchParams.get('directory') },
        data: shells.filter(shell => shell.directory === url.searchParams.get('directory') && shell.status === 'running')
          .map(shell => ({ id: shell.id, status: shell.status, metadata: { sessionID: shell.owner } })),
      })
      if (url.pathname.startsWith('/api/shell/') && method === 'DELETE') {
        const shell = shells.find(shell => shell.id === decodeURIComponent(url.pathname.split('/').at(-1) ?? ''))
        if (shell && !options.keepRunning) shell.status = 'killed'
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith('/wait')) return new Response(null, { status: 204 })
      const node = nodes.find(node => url.pathname.startsWith(`/api/session/${node.id}`))
      if (!node) throw new Error(`Unexpected ${method} ${url}`)
      if (url.pathname.endsWith('/message')) return json({
        data: [{ id: `assistant-${node.id}`, type: 'assistant', sessionID: node.id, content: node.shellID ? [{
          type: 'tool', id: `call-${node.id}`, name: node.tool ?? 'shell',
          state: { status: 'completed', metadata: { shellID: node.shellID } },
        }] : [] }], cursor: {},
      })
      if (url.pathname.endsWith('/interrupt')) return json({ interrupted: true })
      if (method === 'PATCH') {
        permissions.set(node.id, body?.permissions)
        return new Response(null, { status: 204 })
      }
      return json({ data: { id: node.id, location: { directory: node.directory }, permissions: permissions.get(node.id) ?? [] } })
    },
  })
  return { transport, requests, permissions, shells, json }
}

describe('OpenCode v2 session retirement', () => {
  it('verifies a running command whose tool receipt is older than the normal message window', async () => {
    const { transport, requests, shells, json } = fixture({
      nodes: [{ id: 'root', directory: '/worktree', shellID: 'root-shell' }],
      fail: (method, url) => {
        if (method !== 'GET' || !url.pathname.endsWith('/message')) return
        const page = Number(url.searchParams.get('cursor') ?? 0)
        return json({
          data: page < 100
            ? Array.from({ length: 100 }, (_, index) => ({ id: `newer-${page}-${index}`, type: 'assistant', sessionID: 'root', content: [] }))
            : [{ id: 'old-receipt', type: 'assistant', sessionID: 'root', content: [{ type: 'tool', id: 'old-call', name: 'shell', state: { status: 'completed', metadata: { shellID: 'root-shell' } } }] }],
          cursor: page < 100 ? { next: String(page + 1) } : {},
        })
      },
    })
    await expect(transport.retireSession('root', '/worktree')).resolves.toBe(true)
    expect(requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(101)
    expect(shells[0]?.status).toBe('killed')
  })

  it('freezes and stops the task and its children before removing their running commands, retaining transcripts', async () => {
    const { transport, requests, permissions, shells } = fixture()
    const adapter = new OpenCodeSDKAdapter('http://opencode.test', undefined, async () => transport)
    await expect(adapter.abortSession('root', { retire: true })).resolves.toBe(true)
    expect(permissions.get('root')).toEqual([{ action: '*', resource: '*', effect: 'deny' }])
    expect(permissions.get('child')).toEqual(permissions.get('root'))
    expect(shells.every(shell => shell.status === 'killed')).toBe(true)
    const firstShellRemoval = requests.findIndex(request => request.method === 'DELETE')
    for (const id of ['root', 'child']) {
      const freeze = requests.findIndex(request => request.method === 'PATCH' && request.url.pathname === `/api/session/${id}`)
      const stop = requests.findIndex(request => request.url.pathname === `/api/session/${id}/interrupt`)
      const idle = requests.findIndex(request => request.url.pathname === `/api/experimental/session/${id}/wait`)
      const children = requests.findIndex(request => request.url.searchParams.get('parentID') === id)
      expect(freeze).toBeLessThan(stop)
      expect(stop).toBeLessThan(idle)
      expect(idle).toBeLessThan(children)
      expect(children).toBeLessThan(firstShellRemoval)
      expect(requests[stop]?.url.searchParams.get('resume')).toBe('false')
      expect(requests.findLastIndex(request => request.url.pathname === `/api/session/${id}/interrupt`)).toBeGreaterThan(firstShellRemoval)
    }
    expect(requests.filter(request => request.method === 'DELETE').map(request => request.url.pathname))
      .toEqual(['/api/shell/root-shell', '/api/shell/child-shell'])
    expect(await transport.getSessionMessages('root')).toHaveLength(1)
  })

  it('leaves other sessions and their running commands untouched', async () => {
    const foreign: Shell = { id: 'foreign-shell', owner: 'foreign', directory: '/worktree', status: 'running' }
    const { transport, requests } = fixture({
      nodes: [{ id: 'root', directory: '/worktree' }], shells: [foreign],
    })
    await expect(transport.retireSession('root', '/worktree')).resolves.toBe(true)
    expect(foreign.status).toBe('running')
    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
  })

  it('does not trust a shell metadata tag without a matching model-tool receipt', async () => {
    const { transport, requests } = fixture({
      nodes: [{ id: 'root', directory: '/worktree' }],
      shells: [{ id: 'unverified', owner: 'root', directory: '/worktree', status: 'running' }],
    })
    await expect(transport.retireSession('root', '/worktree')).rejects.toThrow('without a verified model-tool receipt')
    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
  })

  it('refuses to remove a verified shell if its session no longer matches', async () => {
    const { transport, requests } = fixture({
      nodes: [{ id: 'root', directory: '/worktree', shellID: 'shell-id' }],
      shells: [{ id: 'shell-id', owner: 'foreign', directory: '/worktree', status: 'running' }],
    })
    await expect(transport.retireSession('root', '/worktree')).rejects.toThrow("changed a verified shell's session")
    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
  })

  it.each(['permissions', 'children', 'commands', 'removal', 'confirmation'] as const)(
    'withholds successful retirement when %s cannot be confirmed', async stage => {
      const { transport, requests } = fixture({
        keepRunning: stage === 'confirmation',
        fail: (method, url) => {
          if (stage === 'permissions' && method === 'GET' && url.pathname === '/api/session/root')
            return new Response(JSON.stringify({ data: { permissions: [] } }))
          if ((stage === 'children' && url.pathname === '/api/session') ||
              (stage === 'commands' && url.pathname === '/api/shell'))
            return new Response(JSON.stringify({ data: {} }))
          if (stage === 'removal' && method === 'DELETE') return new Response('unavailable', { status: 503 })
          return undefined
        },
      })
      await expect(transport.retireSession('root', '/worktree')).rejects.toThrow()
      expect(requests.some(request => request.method === 'DELETE' && request.url.pathname.startsWith('/api/session/'))).toBe(false)
    },
  )

  it('treats a confirmed missing session as already retired', async () => {
    const { transport } = fixture({ fail: () => new Response(JSON.stringify({ _tag: 'SessionNotFoundError' }), { status: 404 }) })
    await expect(transport.retireSession('root', '/worktree')).resolves.toBe(true)
  })

  it('preserves the native failure for retirement diagnostics while ordinary interruption keeps its boolean contract', async () => {
    const { transport } = fixture({ fail: () => new Response('server unavailable', { status: 503 }) })
    const adapter = new OpenCodeSDKAdapter('http://opencode.test', undefined, async () => transport)
    await expect(adapter.abortSession('root', { retire: true })).rejects.toMatchObject({ status: 503 })
    await expect(adapter.abortSession('root')).resolves.toBe(false)
  })

  it('keeps an ordinary interruption suitable for Continue without freezing or removing commands', async () => {
    const { transport, requests, permissions, shells } = fixture()
    const adapter = new OpenCodeSDKAdapter('http://opencode.test', undefined, async () => transport)
    await expect(adapter.abortSession('root')).resolves.toBe(true)
    expect(permissions.size).toBe(0)
    expect(shells.every(shell => shell.status === 'running')).toBe(true)
    expect(requests.some(request => request.method === 'PATCH' || request.method === 'DELETE')).toBe(false)
  })
})
