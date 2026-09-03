import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { countSkipEvents } from '@shared/skipReceipt'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { attachProject } from '../../storage/projects'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  createTicket,
  ensureActivePhaseAttempt,
  insertPhaseArtifact,
  listPhaseArtifacts,
} from '../../storage/tickets'
import {
  deleteSkipReceiptsForAction,
  getActiveSkipReasons,
  hasSkipReceiptsForAction,
  listSkipEvents,
  writeSkipReceipts,
} from '../skipReceipts'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-skip-receipts-',
  files: {
    'README.md': '# LoopTroop Skip Receipts Test\n',
  },
})

function makeTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Skip receipts',
    description: 'Every user action that skips something leaves a trail.',
  })
  return ticket
}

describe('skip receipts', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('records one action and N items for a bulk skip', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_all',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-bulk',
      summary: { itemType: 'interview_batch', reason: 'Out of time before the demo.' },
      items: [
        { itemId: 'Q07', reason: null },
        { itemId: 'Q08', reason: 'Already answered in the ticket description.' },
        { itemId: 'Q09', reason: null },
      ],
    })

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(4)
    expect(countSkipEvents(events)).toEqual({
      actions: 1,
      items: 3,
      itemsWithReason: 1,
      itemsWithoutReason: 2,
    })
  })

  it('writes nothing the second time the same action arrives', () => {
    const ticket = makeTicket()
    const input = {
      ticketId: ticket.id,
      surface: 'interview_question' as const,
      itemType: 'interview_question' as const,
      phase: 'WAITING_INTERVIEW_ANSWERS' as const,
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-replayed',
      items: [{ itemId: 'Q01', reason: 'Not relevant to this ticket.' }],
    }

    expect(writeSkipReceipts(input)).toHaveLength(1)
    expect(hasSkipReceiptsForAction(ticket.id, 'action-replayed')).toBe(true)
    expect(writeSkipReceipts(input)).toHaveLength(0)
    expect(listSkipEvents(ticket.id)).toHaveLength(1)
  })

  it('matches an action by its recorded field, not by a pattern in the row', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question' as const,
      itemType: 'interview_question' as const,
      phase: 'WAITING_INTERVIEW_ANSWERS' as const,
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-first',
      items: [{ itemId: 'Q01', reason: 'See the note about "action_id":"action-second" in the ticket.' }],
    })

    expect(hasSkipReceiptsForAction(ticket.id, 'action-first')).toBe(true)
    expect(hasSkipReceiptsForAction(ticket.id, 'action-second')).toBe(false)
    expect(hasSkipReceiptsForAction(ticket.id, 'action-firs')).toBe(false)
  })

  it('normalizes a blank reason to null rather than an empty string', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'cancel_ticket',
      itemType: 'ticket',
      phase: 'CODING',
      ticketStatusBefore: 'CODING',
      actionId: 'action-blank',
      items: [{ itemId: null, reason: '   \n  ' }],
    })

    expect(listSkipEvents(ticket.id)[0]?.reason).toBeNull()
  })

  it('keeps receipts from archived phase attempts visible to the audit trail', () => {
    const ticket = makeTicket()
    ensureActivePhaseAttempt(ticket.id, 'WAITING_INTERVIEW_ANSWERS')
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-attempt-one',
      items: [{ itemId: 'Q01', reason: 'First pass.' }],
    })

    archiveActivePhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'], 'test_retry')
    createFreshPhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'])
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-attempt-two',
      items: [{ itemId: 'Q01', reason: 'Second pass.' }],
    })

    // The attempt-filtered artifact path hides the first attempt on purpose.
    const visible = listPhaseArtifacts(ticket.id, { phase: 'WAITING_INTERVIEW_ANSWERS' })
    expect(visible).toHaveLength(1)

    // The audit trail must not.
    const events = listSkipEvents(ticket.id)
    expect(events.map((event) => event.reason)).toEqual(['First pass.', 'Second pass.'])
    expect(events[0]?.superseded).toBe(true)
    expect(events[1]?.superseded).toBe(false)
    expect(getActiveSkipReasons(ticket.id).get('interview_question:Q01')).toBe('Second pass.')
  })

  it('refuses to re-attach a reason to an item that is no longer skipped', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-stale',
      items: [
        { itemId: 'Q01', reason: 'Skipped then answered.' },
        { itemId: 'Q02', reason: 'Still skipped.' },
      ],
    })

    // The caller passes the ids the domain artifact still reports as skipped.
    const reasons = getActiveSkipReasons(ticket.id, { itemIds: ['Q02'] })
    expect(reasons.has('interview_question:Q01')).toBe(false)
    expect(reasons.get('interview_question:Q02')).toBe('Still skipped.')
  })

  it('reads the Manual QA skip through the shared API without a second record', () => {
    const ticket = makeTicket()
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_MANUAL_QA',
      artifactType: 'manual_qa_skip_receipt',
      content: JSON.stringify({
        actionId: 'manual-qa-action',
        version: 1,
        reason: 'Verified separately against staging.',
        createdAt: '2026-08-27T09:00:00.000Z',
        idempotencyKey: 'manual-qa-action',
      }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_MANUAL_QA',
      artifactType: 'manual_qa_summary',
      content: JSON.stringify({
        version: 1,
        completedAt: '2026-08-27T09:00:00.000Z',
        waivedItems: [{ itemId: 'QA-3', reason: 'Not reachable on this platform.' }],
        idempotencyKey: 'manual-qa-summary',
      }),
    })

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(2)
    expect(events.find((event) => event.surface === 'manual_qa')?.reason)
      .toBe('Verified separately against staging.')
    const waived = events.find((event) => event.surface === 'manual_qa_item')
    expect(waived?.itemId).toBe('QA-3')
    expect(waived?.reason).toBe('Not reachable on this platform.')
  })


  it('removes an action\'s receipts when its work is rolled back', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-reverted',
      items: [{ itemId: 'Q01', reason: 'Skipped in a batch that then failed.' }],
    })
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-kept',
      items: [{ itemId: 'Q02', reason: 'A committed skip.' }],
    })

    // A batch whose background processing failed is restored to the previous
    // snapshot, so its skips did not happen and neither should their receipts.
    expect(deleteSkipReceiptsForAction(ticket.id, 'action-reverted')).toBe(1)

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.itemId).toBe('Q02')
    // The action id is free again, so the retry records cleanly.
    expect(hasSkipReceiptsForAction(ticket.id, 'action-reverted')).toBe(false)
  })

  it('does not count a resolution as a skip', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-skip',
      items: [{ itemId: 'Q01', reason: 'Out of scope.' }],
    })
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-resolve',
      items: [{ itemId: 'Q01', reason: null, resolves: true }],
    })

    expect(countSkipEvents(listSkipEvents(ticket.id))).toEqual({
      actions: 1,
      items: 1,
      itemsWithReason: 1,
      itemsWithoutReason: 0,
    })
    // The reason is no longer in force, because the item is no longer skipped.
    expect(getActiveSkipReasons(ticket.id).has('interview_question:Q01')).toBe(false)
  })

  it('keeps a Manual QA waiver and an interview question with the same id apart', () => {
    const ticket = makeTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-interview',
      items: [{ itemId: 'Q01', reason: 'Interview reason.' }],
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_MANUAL_QA',
      artifactType: 'manual_qa_summary',
      content: JSON.stringify({
        version: 1,
        completedAt: '2026-08-27T09:00:00.000Z',
        waivedItems: [{ itemId: 'Q01', reason: 'Manual QA reason.' }],
        idempotencyKey: 'manual-qa-summary',
      }),
    })

    const reasons = getActiveSkipReasons(ticket.id)
    expect(reasons.get('interview_question:Q01')).toBe('Interview reason.')
    expect(reasons.get('manual_qa_item:Q01')).toBe('Manual QA reason.')
    // Neither superseded the other despite sharing an item id.
    expect(listSkipEvents(ticket.id).every((event) => !event.superseded)).toBe(true)
  })

  it('stores multiline, Unicode and very long reasons unchanged', () => {
    const ticket = makeTicket()
    const long = 'x'.repeat(20_000)
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-content',
      items: [
        { itemId: 'Q01', reason: 'First line\nSecond line\n\nFourth line' },
        { itemId: 'Q02', reason: 'Ça dépend — 日本語 — 🎯' },
        { itemId: 'Q03', reason: long },
      ],
    })

    const reasons = getActiveSkipReasons(ticket.id)
    expect(reasons.get('interview_question:Q01')).toBe('First line\nSecond line\n\nFourth line')
    expect(reasons.get('interview_question:Q02')).toBe('Ça dépend — 日本語 — 🎯')
    expect(reasons.get('interview_question:Q03')).toBe(long)
  })
})
