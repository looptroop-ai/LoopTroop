import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initializeDatabase } from '../../db/init'
import { db } from '../../db/index'
import { profiles } from '../../db/schema'
import { profileRouter } from '../profiles'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../../../shared/openRouterRouting'
const { mockGetOpenCodeConnection } = vi.hoisted(() => ({ mockGetOpenCodeConnection: vi.fn() }))
vi.mock('../../opencode/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/connection')>(),
  getOpenCodeConnection: mockGetOpenCodeConnection,
}))
import { invalidateOpenCodeConnection } from '../../opencode/connection'
import { beginOpenCodePromptActivity } from '../../opencode/providerCatalogReload'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

vi.mock('../../opencode/modelValidation', () => ({
  validateModelSelection: vi.fn(),
}))

import { validateModelSelection } from '../../opencode/modelValidation'

function createProfileApp() {
  const app = new Hono()
  app.route('/api', profileRouter)
  return app
}

describe('profileRouter numeric validation', () => {
  beforeEach(() => {
    initializeDatabase()
    db.delete(profiles).run()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    mockGetOpenCodeConnection.mockReset()
  })

  it('accepts PRD, beads, structured retry, and OpenCode retry values at the configured bounds', async () => {
    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4'],
    })

    const app = createProfileApp()
    const response = await app.request('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mainImplementer: 'openai/gpt-5.4',
        councilMembers: '["openai/gpt-5.4","anthropic/claude-sonnet-4"]',
        maxPrdCoveragePasses: 2,
        maxBeadsCoveragePasses: 20,
        structuredRetryCount: 5,
        opencodeRetryLimit: 50,
        opencodeRetryDelay: 3_600_000,
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      manualQaEnabled: true,
      ignoreMode: 'local',
      maxPrdCoveragePasses: 2,
      maxBeadsCoveragePasses: 20,
      structuredRetryCount: 5,
      opencodeRetryLimit: 50,
      opencodeRetryDelay: 3_600_000,
    })
  })

  it('initializes and returns structured and OpenCode retry defaults when omitted', async () => {
    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4'],
    })

    const app = createProfileApp()
    const response = await app.request('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mainImplementer: 'openai/gpt-5.4',
        councilMembers: '["openai/gpt-5.4","anthropic/claude-sonnet-4"]',
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      gitHookPolicy: 'validate_advisory',
      structuredRetryCount: 1,
      opencodeRetryLimit: 10,
      opencodeRetryDelay: 60_000,
    })

    const stored = db.select().from(profiles).get()
    expect(stored?.structuredRetryCount).toBe(1)
    expect(stored?.gitHookPolicy).toBe('validate_advisory')
    expect(stored?.ignoreMode).toBe('local')
    expect(stored?.manualQaEnabled).toBe(true)
    expect(stored?.opencodeRetryLimit).toBe(10)
    expect(stored?.opencodeRetryDelay).toBe(60_000)
  })

  it('persists each supported Git hook policy', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4"]',
    }).run()
    const app = createProfileApp()
    for (const gitHookPolicy of ['observe_only', 'validate_advisory', 'validate_required', 'use_native_hooks'] as const) {
      const response = await app.request('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitHookPolicy }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ gitHookPolicy })
    }
  })

  it('persists each supported folder-ignore default', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4"]',
    }).run()
    const app = createProfileApp()
    for (const ignoreMode of ['repo', 'local', 'skip'] as const) {
      const response = await app.request('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignoreMode }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ ignoreMode })
    }
  })

  it.each([
    ['validate_explicitly', 'validate_advisory'],
    ['ignore_internal_only', 'observe_only'],
    ['use_on_internal_commits', 'use_native_hooks'],
  ] as const)('migrates persisted profile policy %s to %s', (legacyPolicy, expected) => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4"]',
      gitHookPolicy: legacyPolicy,
    }).run()

    initializeDatabase()

    expect(db.select().from(profiles).get()?.gitHookPolicy).toBe(expected)
  })

  it('persists the global Manual QA toggle', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4"]',
    }).run()
    const response = await createProfileApp().request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualQaEnabled: true }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ manualQaEnabled: true })
    expect(db.select().from(profiles).get()?.manualQaEnabled).toBe(true)
  })

  it('updates and reads retry settings through the profile API', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4","anthropic/claude-sonnet-4"]',
      structuredRetryCount: 1,
    }).run()

    const app = createProfileApp()
    const patchResponse = await app.request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredRetryCount: 0,
        opencodeRetryLimit: 0,
        opencodeRetryDelay: 0,
      }),
    })

    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({
      structuredRetryCount: 0,
      opencodeRetryLimit: 0,
      opencodeRetryDelay: 0,
    })

    const getResponse = await app.request('/api/profile')
    expect(getResponse.status).toBe(200)
    await expect(getResponse.json()).resolves.toMatchObject({
      structuredRetryCount: 0,
      opencodeRetryLimit: 0,
      opencodeRetryDelay: 0,
    })
  })

  it('preserves OpenRouter routing suffixes when updating other settings', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: JSON.stringify([
        'openrouter/deepseek/deepseek-v4-flash:floor',
        'openrouter/openrouter/free:free',
      ]),
    }).run()

    const response = await createProfileApp().request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opencodeRetryLimit: 5 }),
    })

    expect(response.status).toBe(200)
    expect(db.select().from(profiles).get()).toMatchObject({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: JSON.stringify([
        'openrouter/deepseek/deepseek-v4-flash:floor',
        'openrouter/openrouter/free:free',
      ]),
    })
  })

  it('saves unchanged model settings offline without probing or changing routing config', async () => {
    const directory = makeTempDir('looptroop-profile-offline-')
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    invalidateOpenCodeConnection()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    db.insert(profiles).values({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: JSON.stringify([
        'openrouter/deepseek/deepseek-v4-flash:floor',
        'openrouter/openrouter/free:free',
      ]),
    }).run()

    try {
      const response = await createProfileApp().request('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opencodeRetryLimit: 5 }),
      })

      expect(response.status).toBe(200)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(existsSync(configPath)).toBe(false)
    } finally {
      removeTempDir(directory)
    }
  })

  it.each(['POST', 'PATCH'] as const)('rejects %s OpenRouter model changes before config or profile writes while a prompt is active', async (method) => {
    const directory = makeTempDir('looptroop-profile-busy-')
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    mockGetOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    vi.mocked(validateModelSelection).mockResolvedValue({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: ['openrouter/deepseek/deepseek-v4-flash:floor'],
    })
    if (method === 'PATCH') {
      db.insert(profiles).values({
        mainImplementer: 'openai/gpt-5.4',
        councilMembers: JSON.stringify(['openai/gpt-5.4']),
      }).run()
    }
    const before = db.select().from(profiles).get()
    const releasePrompt = beginOpenCodePromptActivity()

    try {
      const response = await createProfileApp().request('/api/profile', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
          councilMembers: '["openrouter/deepseek/deepseek-v4-flash:floor"]',
        }),
      })

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('active work') })
      expect(existsSync(configPath)).toBe(false)
      expect(db.select().from(profiles).get()).toEqual(before)
    } finally {
      releasePrompt()
      removeTempDir(directory)
    }
  })

  it('rejects out-of-range PRD, beads coverage, structured retry, and OpenCode retry values', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4","anthropic/claude-sonnet-4"]',
    }).run()

    const app = createProfileApp()
    const response = await app.request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxPrdCoveragePasses: 1,
        maxBeadsCoveragePasses: 21,
        structuredRetryCount: 6,
        opencodeRetryLimit: 51,
        opencodeRetryDelay: 3_600_001,
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid input',
    })
  })
})
