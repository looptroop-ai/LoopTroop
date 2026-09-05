import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { MAX_API_JSON_BODY_BYTES, validateJson } from '../validation'

function createValidationApp() {
  const app = new Hono()
  app.use('/api/*', validateJson)
  app.post('/api/tickets', (c) => c.json({ ok: true }))
  app.post('/api/retry', async (c) => c.json({ body: await c.req.text() }))
  return app
}

describe('JSON validation middleware', () => {
  it('rejects oversized JSON bodies before route parsing', async () => {
    const app = createValidationApp()

    const response = await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_API_JSON_BODY_BYTES + 1),
      },
      body: JSON.stringify({ title: 'Too large' }),
    })

    expect(response.status).toBe(413)
  })

  it('rejects invalid content-length values', async () => {
    const app = createValidationApp()

    const response = await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 'nope',
      },
      body: JSON.stringify({ title: 'Invalid length' }),
    })

    expect(response.status).toBe(400)
  })

  it('rejects oversized chunked JSON bodies by byte length', async () => {
    const app = createValidationApp()
    const oversizedJson = JSON.stringify({
      value: '€'.repeat(Math.ceil(MAX_API_JSON_BODY_BYTES / 3) + 100),
    })
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedJson))
        controller.close()
      },
    })

    const request = new Request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)

    const response = await app.request(request)

    expect(response.status).toBe(413)
  })

  it('keeps an empty streamed POST body readable by downstream handlers', async () => {
    const app = createValidationApp()
    const body = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
    const request = new Request('http://localhost/api/retry', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)

    const response = await app.request(request)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: '' })
  })
})

describe('request content types', () => {
  it('rejects text/event-stream as a request body type', async () => {
    const app = createValidationApp()

    const response = await app.request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'data: not json\n\n',
    })

    // It is a response type, not a request one. Letting it through skipped both
    // the 415 and the 2 MiB cap, so a handler calling c.req.json() read an
    // uncapped body.
    expect(response.status).toBe(415)
  })

  it('still exempts the Manual QA evidence upload path by path', async () => {
    const app = new Hono()
    app.use('/api/*', validateJson)
    app.post('/api/tickets/:id/manual-qa/versions/:version/evidence', (c) => c.json({ ok: true }))

    const response = await app.request('/api/tickets/1%3AT-1/manual-qa/versions/1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: 'binary-ish',
    })

    expect(response.status).toBe(200)
  })
})
