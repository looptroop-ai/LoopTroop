import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMergePoller } from '../mergePoller'

const { listNonTerminalTicketsMock, syncWaitingPullRequestTicketMock } = vi.hoisted(() => ({
  listNonTerminalTicketsMock: vi.fn(),
  syncWaitingPullRequestTicketMock: vi.fn(),
}))

vi.mock('../../storage/tickets', () => ({
  listNonTerminalTickets: listNonTerminalTicketsMock,
}))
vi.mock('../../routes/ticketHandlers/routeUtils', () => ({ emitRoutePhaseLog: vi.fn() }))
vi.mock('../mergeCompletion', () => ({ syncWaitingPullRequestTicket: syncWaitingPullRequestTicketMock }))

function ticket(id: string, status = 'WAITING_PR_REVIEW') {
  return { id, status, branchName: `feature/${id}` }
}

describe('daemon merge poller', () => {
  let stop: (() => Promise<void>) | undefined
  let releasePending: (() => void) | undefined

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(0)
    listNonTerminalTicketsMock.mockReset().mockReturnValue([])
    syncWaitingPullRequestTicketMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    releasePending?.()
    await stop?.()
    releasePending = undefined
    stop = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('recovers waiting tickets immediately and discovers new ones without a UI request', async () => {
    listNonTerminalTicketsMock.mockReturnValue([ticket('restored'), ticket('coding', 'CODING')])
    stop = startMergePoller()
    expect(syncWaitingPullRequestTicketMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledExactlyOnceWith('restored')

    listNonTerminalTicketsMock.mockReturnValue([ticket('new')])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenLastCalledWith('new')
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledTimes(2)
  })

  it('backs off each failing ticket independently up to five minutes and resets after success', async () => {
    listNonTerminalTicketsMock.mockReturnValue([ticket('failing'), ticket('healthy')])
    const attempts: number[] = []
    syncWaitingPullRequestTicketMock.mockImplementation(async (id: string) => {
      if (id !== 'failing') return
      attempts.push(Date.now())
      if (attempts.length !== 6) throw new Error('Temporary remote failure')
    })
    stop = startMergePoller()

    await vi.advanceTimersByTimeAsync(1_080_000)
    expect(attempts).toEqual([0, 60_000, 180_000, 420_000, 720_000, 1_020_000, 1_050_000])
    expect(syncWaitingPullRequestTicketMock.mock.calls.filter(([id]) => id === 'healthy')).toHaveLength(37)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempts.at(-1)).toBe(1_110_000)
  })

  it('runs tickets serially and waits thirty seconds after a sweep finishes', async () => {
    listNonTerminalTicketsMock.mockReturnValue([ticket('first'), ticket('second')])
    syncWaitingPullRequestTicketMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releasePending = resolve }))
    stop = startMergePoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledExactlyOnceWith('first')

    await vi.advanceTimersByTimeAsync(120_000)
    expect(listNonTerminalTicketsMock).toHaveBeenCalledTimes(1)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledTimes(1)
    releasePending?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenLastCalledWith('second')

    await vi.advanceTimersByTimeAsync(29_999)
    expect(listNonTerminalTicketsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listNonTerminalTicketsMock).toHaveBeenCalledTimes(2)
  })

  it('recovers discovery after a transient storage failure', async () => {
    listNonTerminalTicketsMock.mockImplementationOnce(() => { throw new Error('Storage temporarily unavailable') })
      .mockReturnValue([ticket('recovered')])
    stop = startMergePoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(syncWaitingPullRequestTicketMock).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[merge-poller] Could not check waiting tickets: Storage temporarily unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledExactlyOnceWith('recovered')
  })

  it('drops backoff once a ticket leaves the waiting state', async () => {
    listNonTerminalTicketsMock.mockReturnValue([ticket('retry')])
    syncWaitingPullRequestTicketMock
      .mockRejectedValueOnce(new Error('Temporary remote failure'))
      .mockRejectedValueOnce(new Error('Temporary remote failure'))
    stop = startMergePoller()
    await vi.advanceTimersByTimeAsync(60_000)
    listNonTerminalTicketsMock.mockReturnValue([])
    await vi.advanceTimersByTimeAsync(30_000)
    listNonTerminalTicketsMock.mockReturnValue([ticket('retry')])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledTimes(3)
  })

  it('can stop before the initial sweep and stop repeatedly', async () => {
    stop = startMergePoller()
    await stop()
    await stop()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(listNonTerminalTicketsMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains an active ticket on stop and skips the remaining sweep', async () => {
    listNonTerminalTicketsMock.mockReturnValue([ticket('first'), ticket('second')])
    syncWaitingPullRequestTicketMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releasePending = resolve }))
    stop = startMergePoller()
    await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releasePending?.()
    await stopping
    await vi.advanceTimersByTimeAsync(90_000)
    expect(syncWaitingPullRequestTicketMock).toHaveBeenCalledExactlyOnceWith('first')
    expect(vi.getTimerCount()).toBe(0)
  })
})
