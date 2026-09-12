import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTicketUiStateActionId } from '../ticketUiStateRevision'
import { newManualQaActionId } from '@/hooks/useManualQA'

describe('client action IDs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([undefined, {}])('rejects an unavailable cryptographic source (%j)', (cryptoApi) => {
    vi.stubGlobal('crypto', cryptoApi)
    expect(createTicketUiStateActionId).toThrow('Web Crypto is unavailable; cannot create an action ID')
    expect(() => newManualQaActionId('evidence')).toThrow('Web Crypto is unavailable; cannot create an action ID')
  })

  it('preserves native UUIDs and Manual QA prefixes', () => {
    const uuid = '3b7fc51c-f6da-4410-9e18-8112bbf50bd1'
    vi.stubGlobal('crypto', { randomUUID: () => uuid })
    expect(createTicketUiStateActionId()).toBe(uuid)
    expect(newManualQaActionId('evidence')).toBe(`evidence:${uuid}`)
  })

  it('uses fresh crypto bytes for every HTTP LAN action without relying on time or Math.random', () => {
    let sample = 0
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(++sample))
    vi.stubGlobal('crypto', { getRandomValues })
    vi.spyOn(Date, 'now').mockReturnValue(0)
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Weak randomness used') })

    expect(createTicketUiStateActionId()).toBe('01'.repeat(16))
    expect(createTicketUiStateActionId()).toBe('02'.repeat(16))
    expect(newManualQaActionId('evidence')).toBe(`evidence:${'03'.repeat(16)}`)
    expect(newManualQaActionId('evidence')).toBe(`evidence:${'04'.repeat(16)}`)
    expect(getRandomValues).toHaveBeenCalledTimes(4)
  })
})
