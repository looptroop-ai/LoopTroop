import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { MockOpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, PromptSessionOptions } from '../../opencode/types'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { generateDrafts } from '../../council/drafter'
import { resetCouncilRounds } from '../../council/memberControl'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { attachRequest, getTicketQuestionState, resetAllQuestionWindows } from '../../workflow/questionWindows'
import { listSkipEvents } from '../../workflow/skipReceipts'
import { isTicketWorkSuspended, resetAllWorkBudgets } from '../../workflow/workBudget'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { ticketRouter } from '../tickets'

// Refusing a question tells OpenCode through the process-wide adapter.
const factory = vi.hoisted(() => ({ adapter: null as MockOpenCodeAdapter | null }))
vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => factory.adapter,
  isMockOpenCodeMode: () => true,
  resetOpenCodeAdapter: () => undefined,
}))

const repoManager = createTestRepoManager('council-member-routes-')
const app = new Hono()
app.route('/api', ticketRouter)

const MODEL_A = 'test/model-a'
const MODEL_B = 'test/model-b'

/** Model B never answers until its prompt is aborted; model A answers at once. */
class StallingAdapter extends MockOpenCodeAdapter {
  readonly prompted: string[] = []
  confirmAborts = true

  override async promptSession(
    sessionId: string,
    parts: PromptPart[],
    signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string> {
    const model = options?.model ? `${options.model.providerID}/${options.model.modelID}` : ''
    this.prompted.push(model)
    if (model === MODEL_B && this.prompted.filter((entry) => entry === MODEL_B).length === 1) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const abortError = new Error('Aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        }, { once: true })
      })
    }
    return super.promptSession(sessionId, parts, signal, options)
  }

  override async abortSession(): Promise<boolean> {
    return this.confirmAborts
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the council round')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function post(ticketId: string, action: 'stop' | 'retry', body: unknown) {
  return app.request(`/api/tickets/${encodeURIComponent(ticketId)}/council/members/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Opens an AI question in Council Drafting Blueprint, on the model's live session unless one is named. */
function askAs(ticketId: string, memberId: string, requestId: string, sessionId?: string) {
  const liveSessionId = sessionId ?? listOpenCodeSessionsForTicket(ticketId, ['active'])
    .find((session) => session.memberId === memberId)?.sessionId
  if (!liveSessionId) throw new Error(`${memberId} has no active session`)
  attachRequest({
    ticketId,
    sessionId: liveSessionId,
    requestId,
    memberId,
    phase: 'DRAFTING_BEADS',
    phaseAttempt: 1,
    windowMs: 300_000,
    questions: [{ question: 'Which store?', header: 'Store', options: [] }],
  })
}

async function startRound(title: string, phase: WorkflowPhaseId = 'COUNCIL_DELIBERATING') {
  const { ticket, paths } = await createInitializedTestTicket(repoManager, { title })
  const adapter = new StallingAdapter()
  factory.adapter = adapter
  const run = generateDrafts(
    adapter,
    [{ modelId: MODEL_A, name: 'A' }, { modelId: MODEL_B, name: 'B' }],
    [{ type: 'text', content: 'Draft the interview questions.' }],
    paths.worktreePath,
    300_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ticketId: ticket.id, phase },
  )
  await waitFor(() => adapter.prompted.includes(MODEL_B))
  return { ticket, run, adapter }
}

describe('council member routes', () => {
  beforeEach(() => {
    resetTestDb()
  })

  afterEach(() => {
    resetCouncilRounds()
    resetAllQuestionWindows()
    resetAllWorkBudgets()
    factory.adapter = null
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('answers 404 for a ticket that does not exist', async () => {
    const res = await post('nope:NOPE-1', 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_A })
    expect(res.status).toBe(404)
  })

  it('rejects a body naming a status without council controls, or carrying extra fields', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, { title: 'Bad council payloads' })
    expect((await post(ticket.id, 'stop', { phase: 'CODING', memberId: MODEL_A })).status).toBe(400)
    expect((await post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING' })).status).toBe(400)
    expect((await post(ticket.id, 'retry', { phase: 'DRAFTING_PRD', memberId: MODEL_A, part: 'all' })).status).toBe(400)
    expect((await post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_A, force: true })).status).toBe(400)
    // Only PRD drafting has parts; naming one anywhere else is a client bug.
    expect((await post(ticket.id, 'retry', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_A, part: 'full_answers' })).status).toBe(400)
    expect((await post(ticket.id, 'retry', { phase: 'DRAFTING_PRD', memberId: MODEL_A, part: 'full_answers' })).status).toBe(409)
  })

  it('answers 409 STEP_NOT_RUNNING when no council round of that status is running', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, { title: 'No council round' })
    const res = await post(ticket.id, 'retry', { phase: 'COUNCIL_VOTING_PRD', memberId: MODEL_A })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This step is no longer running.', code: 'STEP_NOT_RUNNING' })
  })

  it('stops a working model and refuses to stop a finished one', async () => {
    const { ticket, run } = await startRound('Stop through the route')

    const finished = await post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_A })
    expect(finished.status).toBe(409)
    expect(await finished.json()).toMatchObject({ code: 'MEMBER_FINISHED' })

    const unknown = await post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: 'test/nobody' })
    expect(await unknown.json()).toMatchObject({ code: 'UNKNOWN_MEMBER' })

    const stopped = await post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_B })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({
      success: true,
      phase: 'COUNCIL_DELIBERATING',
      memberId: MODEL_B,
      outcome: 'stopped',
    })
    await expect(run).resolves.toMatchObject({ memberOutcomes: { [MODEL_A]: 'completed', [MODEL_B]: 'stopped' } })
  })

  it('restarts a working model and answers once the new run has started', async () => {
    const { ticket, run, adapter } = await startRound('Retry through the route')

    const res = await post(ticket.id, 'retry', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_B })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, phase: 'COUNCIL_DELIBERATING', memberId: MODEL_B })
    await expect(run).resolves.toMatchObject({ memberOutcomes: { [MODEL_A]: 'completed', [MODEL_B]: 'completed' } })
    expect(adapter.prompted.filter((model) => model === MODEL_B)).toHaveLength(2)
  })

  it.each([
    ['stop', 'member_stopped'],
    ['retry', 'member_restarted'],
  ] as const)('closes the model\'s open question on a %s as the person\'s decision, and leaves the others alone', async (action, resolution) => {
    const { ticket, run, adapter } = await startRound(`${action} a model with a question`, 'DRAFTING_BEADS')
    askAs(ticket.id, MODEL_B, 'req_b')
    askAs(ticket.id, MODEL_A, 'req_other', 'ses_elsewhere')

    const res = await post(ticket.id, action, { phase: 'DRAFTING_BEADS', memberId: MODEL_B })
    expect(res.status).toBe(200)
    await run

    // Closed when the person confirmed, not refused: refusing would wake the
    // model for the moment before the stop landed.
    expect(adapter.questionRejections).toEqual([])
    expect(getTicketQuestionState(ticket.id).requests.map((request) => request.requestId)).toEqual(['req_other'])
    const summary = listSkipEvents(ticket.id)
      .find((event) => event.surface === 'opencode_question' && event.isActionSummary)
    expect(summary?.skippedBy).toBe('user')
    expect(summary?.questionContext?.expiry_reason).toBe(resolution)
  })

  it('answers MEMBER_BUSY to a second action sent while the first is still stopping the model', async () => {
    const { ticket, run } = await startRound('Two clicks on one model')

    const [first, second] = await Promise.all([
      post(ticket.id, 'stop', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_B }),
      post(ticket.id, 'retry', { phase: 'COUNCIL_DELIBERATING', memberId: MODEL_B }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const refused = first.status === 409 ? first : second
    expect(await refused.json()).toMatchObject({ code: 'MEMBER_BUSY' })
    await run.catch(() => undefined)
  })

  it('answers 500 STOP_UNCONFIRMED when OpenCode does not confirm the stop, and fails the step', async () => {
    const { ticket, run, adapter } = await startRound('Unconfirmed stop', 'DRAFTING_BEADS')
    askAs(ticket.id, MODEL_B, 'req_b')
    adapter.confirmAborts = false

    const res = await post(ticket.id, 'stop', { phase: 'DRAFTING_BEADS', memberId: MODEL_B })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'STOP_UNCONFIRMED' })
    await expect(run).rejects.toThrow('Could not confirm abort')
    // The question still closed: it can no longer be answered into a session
    // the step gave up on, or hold every model's clock still.
    expect(getTicketQuestionState(ticket.id).requests).toEqual([])
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })
})
