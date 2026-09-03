import { describe, expect, it } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'

/**
 * `[]` from `getSessionMessages` has to mean "the list succeeded and was
 * empty". Swallowing a failure made a cancelled or 5xx call look like a
 * completed turn that produced nothing, and the snapshot retry above it then
 * returned an empty snapshot as though it were real.
 */
function adapterWithFailingClient(error: Error): OpenCodeSDKAdapter {
  const client = {
    session: {
      messages: () => Promise.reject(error),
      get: () => Promise.resolve({ data: { id: 'ses-1' } }),
    },
  } as unknown as ConstructorParameters<typeof OpenCodeSDKAdapter>[1]
  return new OpenCodeSDKAdapter('http://127.0.0.1:1', client)
}

describe('getSessionMessages', () => {
  it('rethrows an abort rather than reporting an empty message list', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(adapterWithFailingClient(abort).getSessionMessages('ses-1'))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rethrows an ordinary transport failure too', async () => {
    await expect(adapterWithFailingClient(new Error('HTTP 503')).getSessionMessages('ses-1'))
      .rejects.toThrow('HTTP 503')
  })
})
