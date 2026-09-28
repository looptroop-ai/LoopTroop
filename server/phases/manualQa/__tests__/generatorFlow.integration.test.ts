import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { getLatestPhaseArtifact, readTicketFile } from '../../../storage/tickets'
import { runOpenCodePrompt } from '../../../workflow/runOpenCodePrompt'
import { handleManualQaChecklistGeneration } from '../generator'
import {
  getManualQaChecklistHash,
  getManualQaStoragePaths,
  readManualQaChecklist,
  readManualQaCoverage,
  readManualQaEvents,
} from '../storage'

vi.mock('../../../workflow/runOpenCodePrompt', () => ({ runOpenCodePrompt: vi.fn() }))

const repoManager = createTestRepoManager('manual-qa-generator-flow-')

beforeEach(() => {
  resetTestDb()
  vi.clearAllMocks()
})

afterAll(() => {
  resetTestDb()
  repoManager.cleanup()
})

describe('Manual QA generation integration', () => {
  it('parses, computes coverage for, and persists the generated checklist', async () => {
    const fixture = await createInitializedTestTicket(repoManager, {
      title: 'Keep selected filters between visits',
    })
    writeFileSync(join(fixture.paths.ticketDir, 'prd.yaml'), [
      'epics:',
      '  - id: EPIC-1',
      '    user_stories:',
      '      - id: US-1',
      '        acceptance_criteria:',
      '          - Selected filter persists after reload.',
      '          - Clearing selection resets the filter.',
      '',
    ].join('\n'))
    vi.mocked(runOpenCodePrompt).mockResolvedValue({
      session: { id: 'manual-qa-session' },
      response: `<MANUAL_QA_CHECKLIST>
summary: Verify filters remain selected after revisiting the page.
not_applicable_prd_refs: []
items:
  - lineage_id: selected-filter-persists
    prior_item_ids: []
    title: Keep the selected filter
    source: prd
    behavior: The selected filter remains active after revisiting the page.
    severity: required
    recheck_state: new
    prerequisites: []
    actions:
      - Select a filter and leave the page.
      - Return to the page.
    expected_result: The filter remains selected.
    prd_refs:
      - ref: EPIC-1/US-1/AC-1
        coverage: full
</MANUAL_QA_CHECKLIST>`,
      messages: [],
      responseMeta: {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: false,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
      },
      attemptMeta: {
        outcome: 'clean',
        responseAccepted: true,
        discardedResponse: false,
        sessionErrored: false,
        latestAssistantErrored: false,
      },
    })
    const sendEvent = vi.fn()

    await handleManualQaChecklistGeneration(fixture.ticket.id, fixture.context, sendEvent)

    const checklist = readManualQaChecklist(fixture.paths.ticketDir, 1)
    expect(checklist).toMatchObject({
      ticketId: fixture.ticket.externalId,
      version: 1,
      summary: 'Verify filters remain selected after revisiting the page.',
      items: [{ id: 'qa-v1-001', lineageId: 'selected-filter-persists' }],
    })
    expect(readManualQaCoverage(fixture.paths.ticketDir, 1)).toMatchObject({
      coveredCount: 1,
      uncoveredCount: 1,
      entries: [
        { criterionRef: 'EPIC-1/US-1/AC-1', status: 'covered', itemIds: ['qa-v1-001'] },
        { criterionRef: 'EPIC-1/US-1/AC-2', status: 'uncovered', itemIds: [] },
      ],
    })
    const reservation = JSON.parse(readFileSync(
      getManualQaStoragePaths(fixture.paths.ticketDir, 1).reservationPath,
      'utf8',
    )) as { state: string; checklistHash: string }
    expect(reservation.state).toBe('complete')
    expect(reservation.checklistHash).toBe(getManualQaChecklistHash(fixture.paths.ticketDir, 1))
    expect(readManualQaEvents(fixture.paths.ticketDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'generation_reserved', version: 1 }),
      expect.objectContaining({ eventType: 'checklist_ready', version: 1 }),
    ]))
    const checklistArtifact = JSON.parse(
      getLatestPhaseArtifact(fixture.ticket.id, 'manual_qa_checklist', 'GENERATING_QA_CHECKLIST')!.content,
    ) as { version: number; checklist: string }
    expect(checklistArtifact).toMatchObject({ version: 1 })
    expect(checklistArtifact.checklist).toContain('selected-filter-persists')
    expect(JSON.parse(
      getLatestPhaseArtifact(fixture.ticket.id, 'manual_qa_coverage', 'GENERATING_QA_CHECKLIST')!.content,
    )).toMatchObject({ coveredCount: 1, uncoveredCount: 1 })
    expect(readTicketFile(fixture.ticket.id, 'ui/artifact-companions/manual_qa_checklist.json'))
      .toContain('selected-filter-persists')
    expect(runOpenCodePrompt).toHaveBeenCalledTimes(1)
    expect(runOpenCodePrompt).toHaveBeenCalledWith(expect.objectContaining({
      model: fixture.context.lockedMainImplementer,
      toolPolicy: 'read_only',
    }))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'QA_CHECKLIST_READY' })
  })
})
