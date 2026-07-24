import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { db } from '../../db/index'
import { profiles } from '../../db/schema'
import { profileRouter } from '../profiles'

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
      manualQaEnabled: false,
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
      gitHookPolicy: 'validate_explicitly',
      structuredRetryCount: 1,
      opencodeRetryLimit: 10,
      opencodeRetryDelay: 60_000,
    })

    const stored = db.select().from(profiles).get()
    expect(stored?.structuredRetryCount).toBe(1)
    expect(stored?.gitHookPolicy).toBe('validate_explicitly')
    expect(stored?.manualQaEnabled).toBe(false)
    expect(stored?.opencodeRetryLimit).toBe(10)
    expect(stored?.opencodeRetryDelay).toBe(60_000)
  })

  it('persists each supported Git hook policy', async () => {
    db.insert(profiles).values({
      mainImplementer: 'openai/gpt-5.4',
      councilMembers: '["openai/gpt-5.4"]',
    }).run()
    const app = createProfileApp()
    for (const gitHookPolicy of ['validate_explicitly', 'use_on_internal_commits', 'ignore_internal_only'] as const) {
      const response = await app.request('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitHookPolicy }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ gitHookPolicy })
    }
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
