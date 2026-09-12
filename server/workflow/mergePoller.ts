import { getErrorMessage } from '@shared/typeGuards'
import { listNonTerminalTickets } from '../storage/tickets'
import { emitRoutePhaseLog } from '../routes/ticketHandlers/routeUtils'
import { syncWaitingPullRequestTicket } from './mergeCompletion'

const POLL_INTERVAL_MS = 30_000
const MAX_RETRY_MS = 300_000

/** One timer per running daemon; persisted waiting tickets are rediscovered on every start. */
export function startMergePoller(): () => Promise<void> {
  const retries = new Map<string, { delay: number; at: number }>()
  let stopped = false
  let running: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout>

  async function poll(): Promise<void> {
    try {
      const tickets = listNonTerminalTickets().filter(ticket => ticket.status === 'WAITING_PR_REVIEW')
      const waitingIds = new Set(tickets.map(ticket => ticket.id))
      for (const id of retries.keys()) {
        if (!waitingIds.has(id)) retries.delete(id)
      }
      // ponytail: one GitHub request chain at a time; add bounded concurrency if large queues need it.
      for (const ticket of tickets) {
        if (stopped) break
        const retry = retries.get(ticket.id)
        if (retry && retry.at > Date.now()) continue
        try {
          await syncWaitingPullRequestTicket(ticket.id)
          retries.delete(ticket.id)
        } catch (error) {
          const delay = Math.min((retry?.delay ?? POLL_INTERVAL_MS) * 2, MAX_RETRY_MS)
          retries.set(ticket.id, { delay, at: Date.now() + delay })
          emitRoutePhaseLog(ticket.id, 'WAITING_PR_REVIEW', 'info',
            `Pull request sync failed; retrying in ${delay / 1000} seconds: ${getErrorMessage(error)}`)
        }
      }
    } catch (error) {
      console.warn(`[merge-poller] Could not check waiting tickets: ${getErrorMessage(error)}`)
    } finally {
      if (!stopped) schedule(POLL_INTERVAL_MS)
    }
  }

  function schedule(delay: number): void {
    timer = setTimeout(() => { running = poll() }, delay)
    timer.unref()
  }

  schedule(0)
  return async () => {
    stopped = true
    clearTimeout(timer)
    await running
  }
}
