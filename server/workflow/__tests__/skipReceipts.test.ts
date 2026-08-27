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
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'action-replayed',
      items: [{ itemId: 'Q01', reason: 'Not relevant to this ticket.' }],
    }

    expect(writeSkipReceipts(input)).toHaveLength(1)
    expect(hasSkipReceiptsForAction(ticket.id, 'action-replayed')).toBe(true)
    expect(writeSkipReceipts(input)).toHaveLength(0)
    expect(listSkipEvents(ticket.id)).toHaveLength(1)
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
    expect(getActiveSkipReasons(ticket.id).get('Q01')).toBe('Second pass.')
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
    expect(reasons.has('Q01')).toBe(false)
    expect(reasons.get('Q02')).toBe('Still skipped.')
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
    expect(reasons.get('Q01')).toBe('First line\nSecond line\n\nFourth line')
    expect(reasons.get('Q02')).toBe('Ça dépend — 日本語 — 🎯')
    expect(reasons.get('Q03')).toBe(long)
  })
})
