/**
 * One clock per governing deadline, and a ledger that can stop it.
 *
 * Every phase timeout in LoopTroop exists to catch a *stuck model*. A model
 * blocked on OpenCode's `question` tool is not stuck — it is waiting on a
 * person. Charging that wait to a machine-work budget is what forced the
 * roadmap's "the question window must be shorter than the governing timeout"
 * contortion, and it is why a five-minute wait used to end a twenty-minute
 * coding attempt as a bare `Timeout` with nothing naming the question.
 *
 * So waiting does not consume working time. While a question is pending the
 * ticket's budgets are suspended; when it resolves they resume with exactly the
 * elapsed wall time credited back. Suspension is driven by events, not a tick,
 * so it is exact and needs no polling.
 *
 * The credit is *ticket-scoped* rather than session-scoped on purpose. There is
 * no single clock to key: `prd/draft.ts` runs PROM10a and PROM10b in two
 * different sessions under one deadline, `council/drafter.ts` and
 * `council/voter.ts` own `Promise.race` timers that never see the prompt timer,
 * and `execution/executor.ts` had its own private copy of the remaining-time
 * helper. A ticket-level ledger reaches all of them.
 */

export type WorkBudgetScope =
  | 'phase_attempt'
  | 'council_member'
  | 'bead_iteration'
  | 'execution_setup'
  | 'prompt'

export interface WorkBudget {
  readonly scope: WorkBudgetScope
  readonly ticketId: string | undefined
  /** The window this budget was created with, before any credit. */
  readonly totalMs: number | undefined
  /** Credit-aware absolute deadline, or undefined when unbounded. */
  deadlineAt(): number | undefined
  /** Credit-aware remaining time, or undefined when unbounded. */
  remainingMs(): number | undefined
  expired(): boolean
  /** True while a question wait is holding this budget still. */
  suspended(): boolean
  /**
   * Fires whenever the deadline moves — on suspend and on resume.
   *
   * A consumer holding a `setTimeout` must clear it while `suspended()` is true
   * and re-arm from `remainingMs()` once it is false. Re-arming during a
   * suspension would fire mid-wait, which is the bug this module exists to
   * prevent. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void
  /** Stop listening. Idempotent; safe to call from a `finally`. */
  release(): void
}

interface TicketLedger {
  /** How many question requests are currently holding this ticket still. */
  depth: number
  /** When the current suspension began, or null when running. */
  suspendedAt: number | null
  /** Credit banked by suspensions that have already ended. */
  bankedMs: number
  budgets: Set<BudgetImpl>
}

const ledgers = new Map<string, TicketLedger>()

function getLedger(ticketId: string): TicketLedger {
  let ledger = ledgers.get(ticketId)
  if (!ledger) {
    ledger = { depth: 0, suspendedAt: null, bankedMs: 0, budgets: new Set() }
    ledgers.set(ticketId, ledger)
  }
  return ledger
}

function creditMs(ledger: TicketLedger | undefined, now: number): number {
  if (!ledger) return 0
  return ledger.suspendedAt === null
    ? ledger.bankedMs
    : ledger.bankedMs + Math.max(0, now - ledger.suspendedAt)
}

class BudgetImpl implements WorkBudget {
  readonly scope: WorkBudgetScope
  readonly ticketId: string | undefined
  readonly totalMs: number | undefined

  private readonly baseDeadlineAt: number | undefined
  private readonly creditAtCreation: number
  private readonly listeners = new Set<() => void>()
  private released = false

  constructor(args: { ticketId?: string | undefined; totalMs?: number | undefined; scope: WorkBudgetScope }) {
    this.scope = args.scope
    this.ticketId = args.ticketId
    const total = args.totalMs !== undefined && Number.isFinite(args.totalMs) && args.totalMs > 0
      ? args.totalMs
      : undefined
    this.totalMs = total
    this.baseDeadlineAt = total === undefined ? undefined : Date.now() + total
    const ledger = this.ticketId ? ledgers.get(this.ticketId) : undefined
    this.creditAtCreation = creditMs(ledger, Date.now())
    if (this.ticketId) getLedger(this.ticketId).budgets.add(this)
  }

  private earnedCredit(now: number): number {
    if (!this.ticketId) return 0
    return Math.max(0, creditMs(ledgers.get(this.ticketId), now) - this.creditAtCreation)
  }

  deadlineAt(): number | undefined {
    if (this.baseDeadlineAt === undefined) return undefined
    return this.baseDeadlineAt + this.earnedCredit(Date.now())
  }

  remainingMs(): number | undefined {
    const deadline = this.deadlineAt()
    return deadline === undefined ? undefined : deadline - Date.now()
  }

  expired(): boolean {
    const remaining = this.remainingMs()
    return remaining !== undefined && remaining <= 0
  }

  suspended(): boolean {
    if (!this.ticketId) return false
    return (ledgers.get(this.ticketId)?.suspendedAt ?? null) !== null
  }

  onChange(listener: () => void): () => void {
    if (this.released) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A misbehaving consumer must not stop the other clocks from re-arming.
      }
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.listeners.clear()
    if (this.ticketId) {
      const ledger = ledgers.get(this.ticketId)
      ledger?.budgets.delete(this)
      if (ledger && ledger.budgets.size === 0 && ledger.depth === 0) ledgers.delete(this.ticketId)
    }
  }
}

export function createWorkBudget(args: {
  ticketId?: string | undefined
  totalMs?: number | undefined
  scope: WorkBudgetScope
}): WorkBudget {
  return new BudgetImpl(args)
}

/**
 * Hold every budget on a ticket still while a person is being waited on.
 *
 * Reference-counted: several models can have questions pending at once, and the
 * clock restarts only when the last one is resolved.
 */
export function suspendTicketWork(ticketId: string): void {
  const ledger = getLedger(ticketId)
  ledger.depth += 1
  if (ledger.depth > 1) return
  ledger.suspendedAt = Date.now()
  for (const budget of [...ledger.budgets]) budget.notify()
}

export function resumeTicketWork(ticketId: string): void {
  const ledger = ledgers.get(ticketId)
  if (!ledger || ledger.depth === 0) return
  ledger.depth -= 1
  if (ledger.depth > 0) return
  if (ledger.suspendedAt !== null) {
    ledger.bankedMs += Math.max(0, Date.now() - ledger.suspendedAt)
    ledger.suspendedAt = null
  }
  for (const budget of [...ledger.budgets]) budget.notify()
  if (ledger.budgets.size === 0) ledgers.delete(ticketId)
}

/** True while at least one question wait is holding this ticket's clocks. */
export function isTicketWorkSuspended(ticketId: string): boolean {
  return (ledgers.get(ticketId)?.suspendedAt ?? null) !== null
}

/**
 * Total time this ticket has spent waiting on a person, this process.
 *
 * In-process only, and deliberately so: the durable answer to "how long did
 * this ticket wait" is the question timer artifacts, which survive a restart.
 * This is the live number, used while a run is in flight.
 */
export function getTicketWaitingMs(ticketId: string): number {
  return creditMs(ledgers.get(ticketId), Date.now())
}

/**
 * Drop a ticket's ledger.
 *
 * Called when a ticket reaches a terminal state or its sessions are torn down.
 * A leftover suspension would otherwise hold the next run's clocks still.
 */
export function clearTicketWorkBudget(ticketId: string): void {
  const ledger = ledgers.get(ticketId)
  if (!ledger) return
  ledger.depth = 0
  ledger.suspendedAt = null
  for (const budget of [...ledger.budgets]) budget.notify()
  ledgers.delete(ticketId)
}

/** Test seam. Never called from production paths. */
export function resetAllWorkBudgets(): void {
  ledgers.clear()
}
