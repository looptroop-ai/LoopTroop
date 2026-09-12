import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { writeJsonl } from '../../io/jsonl'
import { createTicket, getTicketByRef, getTicketContext, listTickets, listWaitingPullRequestTicketRefs, readTicketFile, resolveTicketContainedPath } from '../tickets'
import { DISPLAY_ONLY_MOCK_BRANCH_NAME, resolveReviewCutoffStatus } from '../ticketQueries'
import { questionWaits, ticketStatusHistory, tickets } from '../../db/schema'

const runtimeRepoManager = createTestRepoManager('ticket-runtime-qa-origin-')

describe('resolveReviewCutoffStatus', () => {
  it('uses the pre-error phase when a canceled ticket was canceled from BLOCKED_ERROR', () => {
    expect(resolveReviewCutoffStatus('CANCELED', 'BLOCKED_ERROR', 'CODING')).toBe('CODING')
  })

  it('keeps ordinary canceled tickets on their last working phase', () => {
    expect(resolveReviewCutoffStatus('CANCELED', 'CODING')).toBe('CODING')
  })

  it('keeps live blocked errors on the phase that failed', () => {
    expect(resolveReviewCutoffStatus('BLOCKED_ERROR', 'CODING')).toBe('CODING')
  })

  it('fails conservative when the blocked-error history is missing', () => {
    expect(resolveReviewCutoffStatus('CANCELED', 'BLOCKED_ERROR')).toBeNull()
  })
})

describe('runtime Manual QA bead origin projection', () => {
  beforeEach(() => resetTestDb())
  afterAll(() => {
    resetTestDb()
    runtimeRepoManager.cleanup()
  })

  it('selects only real waiting PR refs across attached projects without projecting tickets', async () => {
    const first = await createInitializedTestTicket(runtimeRepoManager, { title: 'First waiting PR', shortname: 'FIRST' })
    const second = await createInitializedTestTicket(runtimeRepoManager, { title: 'Second waiting PR', shortname: 'SECOND' })
    const firstContext = getTicketContext(first.ticket.id)!
    const secondContext = getTicketContext(second.ticket.id)!
    firstContext.projectDb.update(tickets).set({ status: 'WAITING_PR_REVIEW', branchName: null })
      .where(eq(tickets.id, firstContext.localTicketId)).run()
    secondContext.projectDb.update(tickets).set({ status: 'WAITING_PR_REVIEW', branchName: 'feature/second' })
      .where(eq(tickets.id, secondContext.localTicketId)).run()
    const mock = createTicket({ projectId: first.project.id, title: 'Display mock' })
    const mockContext = getTicketContext(mock.id)!
    firstContext.projectDb.update(tickets).set({ status: 'WAITING_PR_REVIEW', branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME })
      .where(eq(tickets.id, mockContext.localTicketId)).run()
    createTicket({ projectId: second.project.id, title: 'Draft' })

    // Fail if discovery attempts the filesystem enrichment used by toPublicTicket.
    const projection = vi.spyOn(await import('../../ticket/metadata'), 'resolveTicketBaseBranch')
      .mockImplementation(() => { throw new Error('Discovery must not project tickets') })
    try {
      expect(listWaitingPullRequestTicketRefs().sort()).toEqual([first.ticket.id, second.ticket.id].sort())
      expect(projection).not.toHaveBeenCalled()
    } finally {
      projection.mockRestore()
    }
  })

  it('continues discovery after an attached project fails and retries it on the next sweep', async () => {
    const broken = await createInitializedTestTicket(runtimeRepoManager, { title: 'Unavailable project', shortname: 'BROKE' })
    const healthy = await createInitializedTestTicket(runtimeRepoManager, { title: 'Healthy project', shortname: 'HEALTH' })
    for (const setup of [broken, healthy]) {
      const context = getTicketContext(setup.ticket.id)!
      context.projectDb.update(tickets).set({ status: 'WAITING_PR_REVIEW' })
        .where(eq(tickets.id, context.localTicketId)).run()
    }
    const projects = await import('../projects')
    const lookup = projects.getProjectContextById
    const failure = vi.spyOn(projects, 'getProjectContextById').mockImplementation((id) => {
      if (id === broken.project.id) throw new Error('Project database unavailable')
      return lookup(id)
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(listWaitingPullRequestTicketRefs()).toEqual([healthy.ticket.id])
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`project ${broken.project.id}`))
    } finally {
      failure.mockRestore()
      warning.mockRestore()
    }
    expect(listWaitingPullRequestTicketRefs().sort()).toEqual([broken.ticket.id, healthy.ticket.id].sort())
  })

  it('keeps a ticket visible when its workspace is unsafe while refusing file access', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Unsafe workspace' })
    const saved = join(setup.paths.projectRoot, 'saved-ticket')
    renameSync(setup.paths.ticketDir, saved)
    symlinkSync(saved, setup.paths.ticketDir, 'junction')

    const visible = listTickets().find(ticket => ticket.id === setup.ticket.id)
    expect(visible?.title).toBe('Unsafe workspace')
    expect(visible?.runtime.artifactRoot).toBe('')
    expect(() => resolveTicketContainedPath(setup.ticket.id, 'interview.yaml')).toThrow()
  })

  it('continues startup recovery and projection rebuild after one unsafe ticket', async () => {
    const unsafe = await createInitializedTestTicket(runtimeRepoManager, { title: 'Unsafe recovery', shortname: 'UNSAF' })
    const healthy = await createInitializedTestTicket(runtimeRepoManager, { title: 'Healthy recovery', shortname: 'SAFE' })
    const saved = join(unsafe.paths.projectRoot, 'saved-ticket')
    renameSync(unsafe.paths.ticketDir, saved)
    symlinkSync(saved, unsafe.paths.ticketDir, 'junction')
    const { recoverTicketRuntimeArtifacts } = await import('../../startup')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(recoverTicketRuntimeArtifacts().rebuiltProjections).toBe(1)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(unsafe.ticket.id))
      expect(readTicketFile(healthy.ticket.id, 'runtime/state.yaml')).toContain('Healthy recovery')
    } finally {
      warning.mockRestore()
    }
  })

  it('reads contained artifacts, returns null for absence, and rejects escaping descendants', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Contained reads' })
    writeFileSync(join(setup.paths.ticketDir, 'interview.yaml'), 'safe')
    expect(readTicketFile(setup.ticket.id, 'interview.yaml')).toBe('safe')
    expect(readTicketFile(setup.ticket.id, 'missing.yaml')).toBeNull()
    expect(readTicketFile('999999:NONE-1', 'missing.yaml')).toBeNull()
    const outside = join(setup.paths.projectRoot, 'outside-artifacts')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(setup.paths.ticketDir, 'escaped'), 'junction')
    expect(() => readTicketFile(setup.ticket.id, 'escaped/secret.txt')).toThrow()
  })

  it('projects a validated typed origin and drops malformed or unsafe origins', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Runtime QA origin' })
    const origin = {
      schemaVersion: 1,
      actionId: 'manual-qa-submit-one',
      sourceTicketId: setup.ticket.id,
      sourceTicketExternalId: setup.ticket.externalId,
      version: 2,
      modelId: 'provider/manual-qa-model',
      modelSupportsImages: true,
      createdFromManualQaAt: '2026-07-13T12:00:00.000Z',
      sourceItems: [{
        itemId: 'qa-v2-001',
        lineageId: 'delete-ticket',
        behavior: 'Deleting a ticket removes it from the board.',
        observation: 'The ticket remained after confirmation.',
        expectedResult: 'The ticket disappears and stays removed after refresh.',
        evidence: [{
          id: 'screenshot-one',
          originalName: 'failure.png',
          mediaType: 'image/png',
          size: 128,
          sha256: 'a'.repeat(64),
          relativePath: 'manual-qa/v2/evidence/item-qa-v2-001/screenshot-one.png',
        }],
        links: [{ id: 'issue-reference', url: 'https://example.com/issue', label: 'Issue' }],
      }],
      imageDelivery: 'attached',
    }
    writeJsonl(setup.paths.beadsPath, [
      { id: 'qa-fix-valid', title: 'Fix deletion', status: 'pending', iteration: 1, qaOrigin: origin },
      {
        id: 'qa-fix-unsafe-link',
        title: 'Reject unsafe origin',
        status: 'pending',
        iteration: 1,
        qaOrigin: {
          ...origin,
          sourceItems: [{ ...origin.sourceItems[0], links: [{ id: 'unsafe', url: 'javascript:alert(1)' }] }],
        },
      },
    ])

    const runtimeBeads = getTicketByRef(setup.ticket.id)?.runtime.beads
    expect(runtimeBeads?.[0]?.qaOrigin).toEqual(origin)
    expect(runtimeBeads?.[1]?.qaOrigin).toBeNull()
  })

  it('preserves the bead update timestamp used to time the active iteration', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Runtime bead timestamp' })
    writeJsonl(setup.paths.beadsPath, [{
      id: 'active-bead',
      title: 'Active bead',
      status: 'in_progress',
      iteration: 2,
      startedAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-17T04:45:20.704Z',
    }])

    expect(getTicketByRef(setup.ticket.id)?.runtime.beads[0]).toMatchObject({
      startedAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-17T04:45:20.704Z',
    })
  })

  it('projects active implementation time without blocked retry pauses and includes setup/testing breakdowns', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Implementation timing' })
    const context = getTicketContext(setup.ticket.id)
    if (!context) throw new Error('Expected ticket context')

    writeJsonl(setup.paths.beadsPath, [{
      id: 'completed-bead',
      title: 'Completed bead',
      status: 'completed',
      iteration: 2,
      startedAt: '2026-07-20T10:12:00.000Z',
      completedAt: '2026-07-20T11:42:00.000Z',
      updatedAt: '2026-07-20T11:42:00.000Z',
    }, {
      id: 'manual-qa-fix',
      title: 'Manual QA fix',
      status: 'completed',
      iteration: 1,
      startedAt: '2026-07-20T12:00:00.000Z',
      completedAt: '2026-07-20T12:20:00.000Z',
      updatedAt: '2026-07-20T12:20:00.000Z',
      qaOrigin: {
        schemaVersion: 1,
        actionId: 'manual-qa-submit-one',
        sourceTicketId: setup.ticket.id,
        sourceTicketExternalId: setup.ticket.externalId,
        version: 1,
        modelId: null,
        modelSupportsImages: null,
        createdFromManualQaAt: '2026-07-20T11:50:00.000Z',
        sourceItems: [{
          itemId: 'qa-001',
          lineageId: 'qa-001',
          behavior: 'Expected behavior',
          observation: 'Observed behavior',
          expectedResult: 'Correct behavior',
          evidence: [],
          links: [],
        }],
      },
    }])
    context.projectDb.insert(ticketStatusHistory).values([
      { ticketId: context.localTicketId, newStatus: 'PREPARING_EXECUTION_ENV', changedAt: '2026-07-20T10:00:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'CODING', changedAt: '2026-07-20T10:12:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'BLOCKED_ERROR', changedAt: '2026-07-20T11:12:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'CODING', changedAt: '2026-07-20T11:32:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'RUNNING_FINAL_TEST', changedAt: '2026-07-20T11:42:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'WAITING_MANUAL_QA', changedAt: '2026-07-20T11:50:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'CODING', changedAt: '2026-07-20T12:00:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'RUNNING_FINAL_TEST', changedAt: '2026-07-20T12:20:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'COMPLETED', changedAt: '2026-07-20T12:28:00.000Z' },
    ]).run()
    context.projectDb.update(tickets)
      .set({ status: 'COMPLETED' })
      .where(eq(tickets.id, context.localTicketId))
      .run()

    expect(getTicketByRef(setup.ticket.id)?.implementationTiming).toEqual({
      activeDurationMs: 70 * 60_000,
      startedAt: '2026-07-20T10:12:00.000Z',
      lastPlannedBeadFinishedAt: '2026-07-20T11:42:00.000Z',
      manualQaFixDurationMs: 20 * 60_000,
      manualQaFixStartedAt: '2026-07-20T12:00:00.000Z',
      workspacePreparationDurationMs: 12 * 60_000,
      workspacePreparationStartedAt: '2026-07-20T10:00:00.000Z',
      finalTestingDurationMs: 16 * 60_000,
      finalTestingStartedAt: '2026-07-20T11:42:00.000Z',
      // Nobody was asked anything in this run, so none of the durations above
      // had time taken back out of them.
      questionWaitingMs: 0,
    })
  })

  it('bills a question wait to waiting time rather than to coding', async () => {
    const setup = await createInitializedTestTicket(runtimeRepoManager, { title: 'Question wait timing' })
    const context = getTicketContext(setup.ticket.id)
    if (!context) throw new Error('Expected ticket context')

    context.projectDb.insert(ticketStatusHistory).values([
      { ticketId: context.localTicketId, newStatus: 'CODING', changedAt: '2026-07-20T10:00:00.000Z' },
      { ticketId: context.localTicketId, newStatus: 'COMPLETED', changedAt: '2026-07-20T11:00:00.000Z' },
    ]).run()
    context.projectDb.update(tickets)
      .set({ status: 'COMPLETED' })
      .where(eq(tickets.id, context.localTicketId))
      .run()
    // Ten of those sixty minutes were spent waiting on a person.
    context.projectDb.insert(questionWaits).values({
      ticketId: context.localTicketId,
      startedAt: '2026-07-20T10:20:00.000Z',
      endedAt: '2026-07-20T10:30:00.000Z',
    }).run()

    const timing = getTicketByRef(setup.ticket.id)?.implementationTiming
    // A question does not change the ticket's status, so nothing in the status
    // history records the wait — it was billed as coding, which inflated the
    // ticket's active duration and trained the ETA on throughput the model
    // never actually achieved.
    expect(timing?.questionWaitingMs).toBe(10 * 60_000)
    expect(timing?.activeDurationMs).toBe(50 * 60_000)
  })
})
