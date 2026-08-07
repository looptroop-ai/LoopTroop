import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app'

/**
 * 2.3 contract: in production the interface and the API share one origin. The API
 * must always win over a frontend route, unknown deep links must fall back to the
 * SPA document, and a missing hashed asset must 404 rather than receive HTML —
 * otherwise the browser reports a module MIME-type error instead of the real fault.
 */
describe('production static serving', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeClientDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-client-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><title>LoopTroop</title>')
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export const x = 1\n')
    writeFileSync(join(dir, 'favicon.ico'), 'icon')
    return dir
  }

  function makeApp(clientDir: string) {
    return createApp({ mode: 'production', apiToken: 'test-token', clientDir })
  }

  it('serves the SPA document at the root', async () => {
    const response = await makeApp(makeClientDir()).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain('LoopTroop')
  })

  it('falls back to the SPA document for client-side routes', async () => {
    const response = await makeApp(makeClientDir()).request('/tickets/abc/detail')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
  })

  it('requires revalidation of the document so asset hashes cannot go stale', async () => {
    const app = makeApp(makeClientDir())

    for (const path of ['/', '/tickets/abc']) {
      const response = await app.request(path)
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
    }
  })

  it('marks hashed assets immutable', async () => {
    const response = await makeApp(makeClientDir()).request('/assets/index-abc123.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('404s a missing asset instead of returning the SPA document', async () => {
    const response = await makeApp(makeClientDir()).request('/assets/index-missing.js')

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type') ?? '').not.toContain('text/html')
  })

  it('404s an unknown API route instead of returning the SPA document', async () => {
    const response = await makeApp(makeClientDir()).request('/api/does-not-exist', {
      headers: { 'x-looptroop-token': 'test-token' },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type') ?? '').not.toContain('text/html')
  })

  it('keeps API authentication ahead of the static handler', async () => {
    const response = await makeApp(makeClientDir()).request('/api/health')

    expect(response.status).toBe(401)
  })

  it('sends no cross-origin headers in production', async () => {
    const response = await makeApp(makeClientDir()).request('/api/health', {
      headers: { Origin: 'http://localhost:5173', 'x-looptroop-token': 'test-token' },
    })

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('serves only the API when no built interface is present', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'looptroop-noclient-'))
    tempDirs.push(emptyDir)

    const response = await makeApp(emptyDir).request('/')

    expect(response.status).toBe(404)
  })
})
