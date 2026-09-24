import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const resolveBaseUrlMock = vi.hoisted(() => vi.fn(async () => ({
  baseUrl: 'http://127.0.0.1:4096',
  status: 'ready-to-start' as const,
})))
const launchToolMock = vi.hoisted(() => vi.fn(() => ({
  file: '/trusted/opencode',
  args: ['serve'],
  windowsVerbatimArguments: false,
})))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

vi.mock('../scripts/opencode-dev-base-url', async () => {
  const actual = await vi.importActual<typeof import('../scripts/opencode-dev-base-url')>('../scripts/opencode-dev-base-url')
  return { ...actual, resolveOpenCodeBaseUrl: resolveBaseUrlMock }
})

vi.mock('../scripts/tool-path.ts', () => ({ launchTool: launchToolMock }))

const ENV_NAMES = [
  'LOOPTROOP_API_TOKEN',
  'LOOPTROOP_DEV_EVENT_TOKEN',
  'LOOPTROOP_OPENCODE_BASE_URL',
  'LOOPTROOP_OPENCODE_MODE',
  'LOOPTROOP_OPENCODE_PERMISSION_MODE',
  'OPENCODE_PERMISSION',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_ENABLE_EXA',
] as const

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    killed: false,
    kill: vi.fn(),
  })
}

describe('development OpenCode launch environment', () => {
  afterEach(() => {
    spawnMock.mockReset()
    launchToolMock.mockClear()
  })

  it('filters daemon credentials at the actual spawn while retaining managed OpenCode settings', async () => {
    const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
    delete process.env.OPENCODE_PASSWORD
    Object.assign(process.env, {
      LOOPTROOP_API_TOKEN: 'ambient-daemon-token',
      LOOPTROOP_DEV_EVENT_TOKEN: 'ambient-dev-event-token',
      LOOPTROOP_OPENCODE_BASE_URL: 'https://opencode.example.test:4096',
      LOOPTROOP_OPENCODE_PERMISSION_MODE: 'inherit',
      OPENCODE_PERMISSION: '{"bash":"ask"}',
      OPENCODE_SERVER_PASSWORD: 'provider-password',
      OPENCODE_ENABLE_EXA: '0',
    })
    const child = fakeChild()
    spawnMock.mockReturnValue(child)

    try {
      vi.resetModules()
      await import('../scripts/dev-opencode')

      const options = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined
      expect(options?.env).toMatchObject({
        OPENCODE_PERMISSION: '{"bash":"ask"}',
        OPENCODE_PASSWORD: 'provider-password',
        OPENCODE_SERVER_PASSWORD: 'provider-password',
        OPENCODE_ENABLE_EXA: '1',
      })
      expect(options?.env?.LOOPTROOP_API_TOKEN).toBeUndefined()
      expect(options?.env?.LOOPTROOP_DEV_EVENT_TOKEN).toBeUndefined()
      expect(process.env.LOOPTROOP_API_TOKEN).toBe('ambient-daemon-token')
      expect(process.env.LOOPTROOP_DEV_EVENT_TOKEN).toBe('ambient-dev-event-token')
      expect(launchToolMock).toHaveBeenCalledWith(
        'opencode',
        expect.arrayContaining(['serve']),
        expect.objectContaining({ env: options?.env }),
      )
    } finally {
      for (const name of ENV_NAMES) {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
