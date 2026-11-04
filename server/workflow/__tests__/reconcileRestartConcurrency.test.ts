import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_LIST_LIMIT } from '../../lib/constants'

const listing = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  started: [] as string[],
  sessions: [] as Array<{ id: string }>,
  listError: null as Error | null,
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
    listSessions: async () => {
      if (listing.listError) throw listing.listError
      return listing.sessions
    },
  }),
}))

const { listLiveOpenCodeSessionIds, reconcilePendingQuestionsAfterRestart } = await import('../questionWindows')

function owners(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `ses_${index}`, ticketId: '1:T-1', memberId: null, phase: 'CODING' as const, phaseAttempt: 1, active: false,
  }))
}

describe('restart question reconciliation', () => {
  beforeEach(() => {
    listing.inFlight = 0
    listing.maxInFlight = 0
    listing.started = []
    listing.sessions = []
    listing.listError = null
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
})

describe('listLiveOpenCodeSessionIds', () => {
  beforeEach(() => {
    listing.sessions = []
    listing.listError = null
  })

  it('returns the listed session ids', async () => {
    listing.sessions = [{ id: 'ses_a' }, { id: 'ses_b' }]
    expect(await listLiveOpenCodeSessionIds()).toEqual(new Set(['ses_a', 'ses_b']))
  })

  it('treats an empty listing as no live sessions', async () => {
    expect(await listLiveOpenCodeSessionIds()).toEqual(new Set())
  })

  it('cannot say when the listing fails or may have been cut at the limit', async () => {
    listing.listError = new Error('ECONNREFUSED')
    expect(await listLiveOpenCodeSessionIds()).toBeNull()
    listing.listError = null
    listing.sessions = Array.from({ length: SESSION_LIST_LIMIT }, (_, index) => ({ id: `ses_${index}` }))
    expect(await listLiveOpenCodeSessionIds()).toBeNull()
  })
})
