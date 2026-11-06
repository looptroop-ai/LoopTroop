import { beforeEach, describe, expect, it, vi } from 'vitest'

const listing = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  started: [] as string[],
  /** What the adapter's complete listing answers; undefined = no such method (v1). */
  live: undefined as ReadonlySet<string> | null | undefined,
  listError: null as Error | null,
  /** Sessions an exact lookup reports as gone, and ones whose lookup fails. */
  gone: new Set<string>(),
  lookupFails: new Set<string>(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({
    listPendingQuestions: async (_root: unknown, _signal: unknown, sessionId: string) => {
      listing.started.push(sessionId)
      listing.inFlight++
      listing.maxInFlight = Math.max(listing.maxInFlight, listing.inFlight)
      const index = Number(sessionId.slice(4))
      // Later owners finish first, and every fifth owner fails.
      await new Promise((resolve) => setTimeout(resolve, 40 - index))
      listing.inFlight--
      if (index % 5 === 0) throw new Error('ECONNREFUSED')
      return []
    },
    getSession: async (sessionId: string) => {
      if (listing.lookupFails.has(sessionId)) throw new Error('ECONNRESET')
      return listing.gone.has(sessionId) ? null : { id: sessionId }
    },
    ...(listing.live === undefined ? {} : {
      listAllSessionIds: async () => {
        if (listing.listError) throw listing.listError
        return listing.live
      },
    }),
  }),
}))

const { listLiveOpenCodeSessionIds, reconcilePendingQuestionsAfterRestart } = await import('../questionWindows')

function owners(count: number, active = false) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `ses_${index}`, ticketId: '1:T-1', memberId: null, phase: 'CODING' as const, phaseAttempt: 1, active,
  }))
}

describe('restart question reconciliation', () => {
  beforeEach(() => {
    listing.inFlight = 0
    listing.maxInFlight = 0
    listing.started = []
    listing.live = undefined
    listing.listError = null
    listing.gone = new Set()
    listing.lookupFails = new Set()
  })

  it('asks at most eight sessions at once, in owner order, and still counts every failure', async () => {
    const all = owners(20)
    const result = await reconcilePendingQuestionsAfterRestart({ projectRoot: '/unused', owners: all, windowMsFor: () => 60_000 })
    expect(listing.maxInFlight).toBe(8)
    expect(listing.started).toEqual(all.map((owner) => owner.sessionId))
    expect(result).toEqual({ reattached: 0, rejected: 0, unverified: 4 })
  })

  it('asks only sessions OpenCode still has, so gone sessions are not unverified', async () => {
    const all = owners(20)
    const live = new Set(['ses_1', 'ses_5', 'ses_7'])
    const result = await reconcilePendingQuestionsAfterRestart({
      projectRoot: '/unused', owners: all, windowMsFor: () => 60_000, liveSessionIds: live,
    })
    expect(listing.started).toEqual(['ses_1', 'ses_5', 'ses_7'])
    // ses_5 is the only asked session that fails; the 17 gone sessions count for nothing.
    expect(result).toEqual({ reattached: 0, rejected: 0, unverified: 1 })
  })

  it('does not count a session OpenCode confirms gone as unverified, but does one it cannot look up', async () => {
    // ses_0, ses_5, ses_10 and ses_15 fail to list. Of those, OpenCode answers
    // that ses_0 and ses_10 do not exist, and the lookup of ses_5 fails.
    listing.gone = new Set(['ses_0', 'ses_10'])
    listing.lookupFails = new Set(['ses_5'])
    const result = await reconcilePendingQuestionsAfterRestart({ projectRoot: '/unused', owners: owners(20), windowMsFor: () => 60_000 })
    expect(result).toEqual({ reattached: 0, rejected: 0, unverified: 2 })
  })

  it('always asks a session that reconnected, whatever the listing says', async () => {
    // Reconnection found these by exact lookup, so a listing that omits them is
    // wrong about them, and skipping them would let startup close live waits.
    const result = await reconcilePendingQuestionsAfterRestart({
      projectRoot: '/unused', owners: owners(3, true), windowMsFor: () => 60_000, liveSessionIds: new Set(),
    })
    expect(listing.started).toEqual(['ses_0', 'ses_1', 'ses_2'])
    expect(result.unverified).toBe(1)
  })
})

describe('listLiveOpenCodeSessionIds', () => {
  beforeEach(() => {
    listing.live = undefined
    listing.listError = null
  })

  it('returns what a complete listing found', async () => {
    listing.live = new Set(['ses_a', 'ses_b'])
    expect(await listLiveOpenCodeSessionIds()).toEqual(new Set(['ses_a', 'ses_b']))
  })

  it('cannot say when the transport cannot list every project, or the listing fails or is incomplete', async () => {
    expect(await listLiveOpenCodeSessionIds()).toBeNull()
    listing.live = null
    expect(await listLiveOpenCodeSessionIds()).toBeNull()
    listing.live = new Set(['ses_a'])
    listing.listError = new Error('ECONNREFUSED')
    expect(await listLiveOpenCodeSessionIds()).toBeNull()
  })
})
