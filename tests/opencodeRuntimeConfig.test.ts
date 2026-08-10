import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_OPENCODE_BASE_URL } from '../shared/appConfig'
import {
  configureOpenCodeRuntime,
  getOpenCodeBaseUrl,
  isOpenCodeMockMode,
  resetOpenCodeRuntimeConfig,
} from '../server/opencode/runtimeConfig'
import { getOpenCodeAdapter, isMockOpenCodeMode, resetOpenCodeAdapter } from '../server/opencode/factory'
import { resolveSettings } from '../server/lib/appSettings'
import { startDaemon } from '../server/daemon/startDaemon'

/**
 * `opencodeBaseUrl` and `opencodeMode` in config.json were resolved, printed by
 * `doctor`, and then ignored: the adapter read the environment directly. A user
 * who pointed their config file at another port kept talking to the default one,
 * while `doctor` health-checked the port they asked for and called it reachable.
 */
describe('OpenCode runtime configuration', () => {
  const ENV_KEYS = ['LOOPTROOP_OPENCODE_BASE_URL', 'LOOPTROOP_OPENCODE_MODE'] as const
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    resetOpenCodeRuntimeConfig()
    resetOpenCodeAdapter()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    resetOpenCodeRuntimeConfig()
    resetOpenCodeAdapter()
  })

  it('falls back to the environment before a host has resolved settings', () => {
    process.env.LOOPTROOP_OPENCODE_BASE_URL = 'http://127.0.0.1:7777'
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'

    expect(getOpenCodeBaseUrl()).toBe('http://127.0.0.1:7777')
    expect(isOpenCodeMockMode()).toBe(true)
  })

  it('falls back to the documented default with no configuration at all', () => {
    expect(getOpenCodeBaseUrl()).toBe(DEFAULT_OPENCODE_BASE_URL)
    expect(isOpenCodeMockMode()).toBe(false)
  })

  it('prefers resolved settings over the environment', () => {
    process.env.LOOPTROOP_OPENCODE_BASE_URL = 'http://127.0.0.1:7777'

    configureOpenCodeRuntime(resolveSettings({
      env: {},
      file: { opencodeBaseUrl: 'http://127.0.0.1:8888', opencodeMode: 'mock' },
    }))

    expect(getOpenCodeBaseUrl()).toBe('http://127.0.0.1:8888')
    expect(isOpenCodeMockMode()).toBe(true)
  })

  /**
   * The env var still wins over config.json — that precedence lives in
   * resolveSettings and is not this layer's call to make. What matters here is
   * that whatever resolveSettings decided is what the adapter gets.
   */
  it('carries the resolved precedence rather than re-deciding it', () => {
    const settings = resolveSettings({
      env: { LOOPTROOP_OPENCODE_BASE_URL: 'http://127.0.0.1:7777' },
      file: { opencodeBaseUrl: 'http://127.0.0.1:8888' },
    })

    configureOpenCodeRuntime(settings)

    expect(getOpenCodeBaseUrl()).toBe(settings.opencodeBaseUrl)
    expect(getOpenCodeBaseUrl()).toBe('http://127.0.0.1:7777')
  })

  it('drives the adapter the factory builds', () => {
    configureOpenCodeRuntime(resolveSettings({ env: {}, file: { opencodeMode: 'mock' } }))

    expect(isMockOpenCodeMode()).toBe(true)
    expect(getOpenCodeAdapter().constructor.name).toBe('MockOpenCodeAdapter')
  })

  /**
   * The singleton is built during module import — `server/workflow/phases/state.ts`
   * is reachable from the route graph — so a config resolved at start() lands on
   * an adapter that already has its client unless the instance is dropped.
   */
  it('replaces an adapter that was already built against the environment', () => {
    process.env.LOOPTROOP_OPENCODE_MODE = 'live'
    const stale = getOpenCodeAdapter()
    expect(stale.constructor.name).toBe('OpenCodeSDKAdapter')

    configureOpenCodeRuntime(resolveSettings({ env: {}, file: { opencodeMode: 'mock' } }))
    resetOpenCodeAdapter()

    expect(getOpenCodeAdapter().constructor.name).toBe('MockOpenCodeAdapter')
  })

  /**
   * Every workflow phase reaches OpenCode through the `adapter` binding in
   * `phases/state`. That module used to capture the instance at import, which
   * happens while `server/app.ts` is still loading — before any config exists —
   * so dropping the singleton could not reach the phases. The binding resolves
   * on use now, and this is the assertion that keeps it that way.
   */
  it('reaches the workflow phases through the state binding', async () => {
    const { adapter } = await import('../server/workflow/phases/state')
    // Resolve the binding first, exactly as an import-time capture would have.
    expect(typeof adapter.checkHealth).toBe('function')

    // A reset builds a new instance, which is what applying a config at start()
    // does. Marking that instance is a class-agnostic way to ask which one the
    // phases actually talk to — a captured binding still points at the old
    // object and never sees the marker.
    resetOpenCodeAdapter()
    const current = getOpenCodeAdapter() as unknown as { marker?: string }
    current.marker = 'rebuilt'

    expect((adapter as unknown as { marker?: string }).marker).toBe('rebuilt')
  })

  /**
   * The whole point of the change, exercised the way a user meets it: a base URL
   * written to config.json with no environment variable anywhere, and the daemon
   * started against that config dir. The supervisor launches the server these
   * settings name, so an adapter built from the environment alone would spend the
   * session talking to a port nothing is listening on.
   */
  it('carries config.json through the daemon to the adapter', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'looptroop-oc-config-'))

    try {
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ opencodeBaseUrl: 'http://127.0.0.1:8899', opencodeMode: 'mock' }),
      )

      const handle = await startDaemon({
        configDir,
        // Port 0 so this never collides with a real daemon or another test file.
        settings: { ...resolveSettings({ configDir, env: {} }), port: 0, portIsExplicit: false },
        version: '0.0.0-test',
      })

      try {
        expect(getOpenCodeBaseUrl()).toBe('http://127.0.0.1:8899')
        expect(isOpenCodeMockMode()).toBe(true)
      } finally {
        await handle.stop()
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
