import { describe, expect, it, vi } from 'vitest'

const listing = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, started: [] as string[] }))

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
  }),
}))

const { reconcilePendingQuestionsAfterRestart } = await import('../questionWindows')

describe('restart question reconciliation', () => {
  it('asks at most eight sessions at once, in owner order, and still counts every failure', async () => {
    const owners = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `ses_${index}`, ticketId: '1:T-1', memberId: null, phase: 'CODING' as const, phaseAttempt: 1, active: false,
    }))
    const result = await reconcilePendingQuestionsAfterRestart({ projectRoot: '/unused', owners, windowMsFor: () => 60_000 })
    expect(listing.maxInFlight).toBe(8)
    expect(listing.started).toEqual(owners.map((owner) => owner.sessionId))
    expect(result).toEqual({ reattached: 0, rejected: 0, unverified: 4 })
  })
})
