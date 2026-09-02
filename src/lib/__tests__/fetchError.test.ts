import { describe, it, expect } from 'vitest'
import { describeQueryError, failedResponseError, throwIfNotOk } from '../fetchError'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('failedResponseError', () => {
  it('quotes the status and the server\'s own error, the pair that names the cause', async () => {
    const error = await failedResponseError(
      jsonResponse(503, { error: 'API token not configured' }),
      'Failed to fetch tickets',
    )

    expect(error.message).toBe('Failed to fetch tickets (HTTP 503: API token not configured)')
  })

  it('still reports the status when the body carries no error field', async () => {
    const error = await failedResponseError(jsonResponse(500, { unrelated: true }), 'Failed to fetch tickets')

    // The body is not dropped: an unrecognised shape is still better than
    // nothing, but the status is what must always survive.
    expect(error.message).toContain('HTTP 500')
  })

  it('reports the status alone for an empty body', async () => {
    const error = await failedResponseError(new Response('', { status: 502 }), 'Failed to fetch projects')

    expect(error.message).toBe('Failed to fetch projects (HTTP 502)')
  })

  it('quotes a plain-text body, which is what a proxy returns', async () => {
    const error = await failedResponseError(new Response('Bad Gateway', { status: 502 }), 'Failed to fetch tickets')

    expect(error.message).toBe('Failed to fetch tickets (HTTP 502: Bad Gateway)')
  })

  it('caps a long body so an HTML error page cannot fill the banner', async () => {
    const error = await failedResponseError(new Response('x'.repeat(5000), { status: 500 }), 'Failed to fetch tickets')

    expect(error.message.length).toBeLessThan(300)
    expect(error.message).toContain('…')
  })

  it('keeps both halves of a category-and-detail body', async () => {
    // The mutation hooks used to compose this pair themselves and drop the
    // status. Neither half is redundant: the category names the rule, the
    // message names what broke it.
    const error = await failedResponseError(
      jsonResponse(400, { error: 'Invalid input', message: 'title is required' }),
      'Failed to create ticket',
    )

    expect(error.message).toBe('Failed to create ticket (HTTP 400: Invalid input: title is required)')
  })

  it('prints a repeated category and detail once', async () => {
    const error = await failedResponseError(
      jsonResponse(400, { error: 'Ticket is locked', message: 'Ticket is locked' }),
      'Failed to update ticket',
    )

    expect(error.message).toBe('Failed to update ticket (HTTP 400: Ticket is locked)')
  })

  it('lists a validation array, which is how prompt saves fail', async () => {
    const error = await failedResponseError(
      jsonResponse(400, { errors: ['unknown variable {{foo}}', 'unbalanced braces'] }),
      'Failed to save prompt',
    )

    expect(error.message).toBe('Failed to save prompt (HTTP 400: unknown variable {{foo}}; unbalanced braces)')
  })

  it('quotes a string `details`, which the project routes send instead of `message`', async () => {
    const error = await failedResponseError(
      jsonResponse(400, { error: 'Invalid folder', details: 'No git repository found' }),
      'Failed to create project',
    )

    expect(error.message).toBe('Failed to create project (HTTP 400: Invalid folder: No git repository found)')
  })

  it('never interpolates an object `details` into the banner', async () => {
    // Some routes put a Zod field map there. Joined into a string it reads
    // "[object Object]", which is worse than the category on its own.
    const error = await failedResponseError(
      jsonResponse(400, { error: 'Invalid input', details: { fieldErrors: { name: ['Required'] } } }),
      'Failed to create project',
    )

    expect(error.message).toBe('Failed to create project (HTTP 400: Invalid input)')
    expect(error.message).not.toContain('object Object')
  })

  it('never throws while describing a failure, even on an unreadable body', async () => {
    // A response whose body already errored is exactly what an aborted request
    // leaves behind; describing the failure must not replace it with a new one.
    const unreadable = {
      status: 500,
      text: () => Promise.reject(new Error('body already consumed')),
    } as unknown as Response

    const error = await failedResponseError(unreadable, 'Failed to fetch tickets')

    expect(error.message).toBe('Failed to fetch tickets (HTTP 500)')
  })
})

describe('throwIfNotOk', () => {
  it('throws the described error for a failure', async () => {
    await expect(throwIfNotOk(jsonResponse(404, { error: 'Ticket not found' }), 'Failed to fetch ticket'))
      .rejects.toThrow('Failed to fetch ticket (HTTP 404: Ticket not found)')
  })

  it('leaves a successful response and its unread body alone', async () => {
    const res = jsonResponse(200, { id: 't1' })

    await expect(throwIfNotOk(res, 'Failed to fetch ticket')).resolves.toBeUndefined()
    // The body must survive: every caller reads it on the next line.
    expect(await res.json()).toEqual({ id: 't1' })
  })
})

describe('describeQueryError', () => {
  it('reads the message off an Error', () => {
    expect(describeQueryError(new Error('Failed to fetch tickets (HTTP 503)')))
      .toBe('Failed to fetch tickets (HTTP 503)')
  })

  it('accepts a bare string, which a rejected promise may carry instead', () => {
    expect(describeQueryError('boom')).toBe('boom')
  })

  it('reports nothing for a blank or unrecognised rejection', () => {
    // The banner drops the detail line entirely rather than printing an empty
    // one or "[object Object]".
    expect(describeQueryError(new Error('   '))).toBeNull()
    expect(describeQueryError('')).toBeNull()
    expect(describeQueryError(undefined)).toBeNull()
    expect(describeQueryError({ status: 503 })).toBeNull()
  })
})
