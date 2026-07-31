import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'

let configDir: string
const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR

async function buildApp() {
  const { promptsRouter } = await import('../prompts')
  const { initPromptTemplates } = await import('../../prompts/templateStore')
  initPromptTemplates()
  const app = new Hono()
  app.route('/api', promptsRouter)
  return app
}

beforeEach(() => {
  configDir = mkdtempSync(resolve(tmpdir(), 'looptroop-prompts-route-'))
  process.env.LOOPTROOP_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('prompts routes', () => {
  it('returns grouped prompts with a General group last', async () => {
    const app = await buildApp()
    const res = await app.request('/api/prompts')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.groups.length).toBeGreaterThan(1)
    expect(body.groups[body.groups.length - 1].id).toBe('general')
    expect(body.modifiedCount).toBe(0)
    expect(body.warnings).toEqual([])
  })

  it('returns current and default source for a prompt', async () => {
    const app = await buildApp()
    const res = await app.request('/api/prompts/PROM0')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.id).toBe('PROM0')
    expect(body.kind).toBe('template')
    expect(body.current).toBe(body.default)
    expect(body.modified).toBe(false)
  })

  it('404s on an unknown prompt id', async () => {
    const app = await buildApp()
    expect((await app.request('/api/prompts/NOPE')).status).toBe(404)
  })

  it('saves a valid edit and then reverts it', async () => {
    const app = await buildApp()
    const detail = await (await app.request('/api/prompts/PROM0')).json()
    const edited = detail.current.replace(/^task: .*$/m, 'task: A customized task line.')

    const saveRes = await app.request('/api/prompts/PROM0', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: edited }),
    })
    expect(saveRes.status).toBe(200)
    expect((await saveRes.json()).errors).toEqual([])

    const afterSave = await (await app.request('/api/prompts/PROM0')).json()
    expect(afterSave.modified).toBe(true)

    const revertRes = await app.request('/api/prompts/PROM0/revert', { method: 'POST' })
    expect(revertRes.status).toBe(200)
    expect((await revertRes.json()).modified).toBe(false)
  })

  it('rejects an invalid edit with 400 and structured errors', async () => {
    const app = await buildApp()
    const res = await app.request('/api/prompts/PROM0', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'id: PROM_RENAMED\n' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).errors.length).toBeGreaterThan(0)
  })

  it('builds a preview that includes the global rules block', async () => {
    const app = await buildApp()
    const detail = await (await app.request('/api/prompts/PROM0')).json()
    const res = await app.request('/api/prompts/PROM0/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: detail.current }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).preview.length).toBeGreaterThan(0)
  })

  it('resets all prompts back to defaults', async () => {
    const app = await buildApp()
    const detail = await (await app.request('/api/prompts/PROM0')).json()
    await app.request('/api/prompts/PROM0', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: detail.current.replace(/^task: .*$/m, 'task: Changed.') }),
    })

    const resetRes = await app.request('/api/prompts/reset-all', { method: 'POST' })
    expect(resetRes.status).toBe(200)

    const catalog = await (await app.request('/api/prompts')).json()
    expect(catalog.modifiedCount).toBe(0)
  })
})
