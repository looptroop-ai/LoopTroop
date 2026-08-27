import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import {
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  insertPhaseArtifact,
  listTickets,
  listPhaseAttempts,
  patchTicket,
} from '../../../storage/tickets'
import {
  buildFinalTestFileEffectsAudit,
  captureFinalTestDirtyFiles,
} from '../../finalTest/fileEffectsAudit'
import { prepareManualQaCheckpoint } from '../checkpoint'
import { reserveManualQaSubmissionOperation, skipManualQa, submitManualQa } from '../operations'
import {
  getManualQaChecklistHash,
  getManualQaStoragePaths,
  persistManualQaChecklist,
  persistManualQaResults,
  persistManualQaSummary,
  readManualQaResults,
  streamManualQaEvidence,
} from '../storage'
import type { ManualQaChecklist, ManualQaDraft, ManualQaSummary } from '../types'
import { readJsonl, writeJsonl } from '../../../io/jsonl'
import type { Bead } from '../../beads/types'
import { listSkipEvents } from '../../../workflow/skipReceipts'

const repoManager = createTestRepoManager('manual-qa-operations-')

function checklistItem(id: string, required = true): ManualQaChecklist['items'][number] {
  return {
    id,
    lineageId: `lineage-${id}`,
    priorItemIds: [],
    title: `Verify ${id}`,
    source: 'implementation_diff',
    behavior: `${id} remains usable`,
    severity: required ? 'required' : 'optional',
    recheckState: 'new',
    prerequisites: [],
    actions: [`Exercise ${id}`],
    expectedResult: `${id} works`,
    watchNotes: [],
    beadRefs: [],
    prdRefs: [],
  }
}

function prepareFixture(items = [checklistItem('item-one')]) {
  const setup = createInitializedTestTicket(repoManager, { title: 'Manual QA submission' })
  const clean = captureFinalTestDirtyFiles(setup.paths.worktreePath)
  insertPhaseArtifact(setup.ticket.id, {
    phase: 'RUNNING_FINAL_TEST',
    artifactType: 'final_test_file_effects_audit',
    content: JSON.stringify(buildFinalTestFileEffectsAudit({
      baselineDirtyFiles: clean,
      dirtyFilesAfterTesting: clean,
      declaredEffects: [],
    })),
  })
  prepareManualQaCheckpoint(setup.ticket.id, 1)
  persistManualQaChecklist(setup.paths.ticketDir, {
    schemaVersion: 1,
    artifact: 'manual_qa_checklist',
    ticketId: setup.ticket.externalId,
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: 'Verify the implemented behavior.',
    notApplicablePrdRefs: [],
    items,
  })
  const checklistHash = getManualQaChecklistHash(setup.paths.ticketDir, 1)!
  patchTicket(setup.ticket.id, { status: 'WAITING_MANUAL_QA' })
  insertPhaseArtifact(setup.ticket.id, {
    phase: 'UI_STATE',
    artifactType: 'ui_state:manual_qa_draft:v1',
    content: JSON.stringify({ revision: 1, data: {} }),
  })
  const draft: ManualQaDraft = {
    schemaVersion: 1,
    artifact: 'manual_qa_draft',
    ticketId: setup.ticket.externalId,
    version: 1,
    checklistHash,
    draftRevision: 1,
    results: items.map((item) => ({
      itemId: item.id,
      outcome: 'pass',
      note: '',
      observation: '',
      reason: '',
      evidenceIds: [],
      links: [],
    })),
    improvements: [],
    evidence: [],
    updatedAt: new Date().toISOString(),
  }
  return {
    ...setup,
    draft,
    guard: { actionId: 'submit-one', operationType: 'submit' as const, expectedChecklistHash: checklistHash, expectedDraftRevision: 1 },
  }
}

function byteStream(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value)
      controller.close()
    },
  })
}

function terminalSummary(
  setup: ReturnType<typeof prepareFixture>,
  outcome: 'passed' | 'skipped',
  skipReason?: string,
): ManualQaSummary {
  return {
    schemaVersion: 1,
    artifact: 'manual_qa_summary',
    ticketId: setup.ticket.externalId,
    version: 1,
    outcome,
    createdFixBeadIds: [],
    improvementTicketIds: [],
    waivedItemIds: [],
    waivedItems: [],
    ...(skipReason ? { skipReason } : {}),
    startedAt: '2026-07-13T12:00:00.000Z',
    completedAt: '2026-07-13T12:01:00.000Z',
    durationMs: 60_000,
    itemCounts: { pass: 1, fail: 0, waive: 0, improvement: 0, pending: 0 },
    requiredItemCount: 1,
    optionalItemCount: 0,
    evidenceCount: 0,
    nextAction: 'integrate',
    coverage: { covered: 0, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
    modelCapability: null,
  }
}

describe('Manual QA submission recovery and integrity', () => {
  beforeEach(() => resetTestDb())
  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('persists top-level summary artifacts and re-dispatches a durable untransitioned outcome', async () => {
    const setup = prepareFixture()
    const firstEvent = vi.fn()
    const summary = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: firstEvent,
    })
    expect(summary.outcome).toBe('passed')
    expect(summary).toMatchObject({
      itemCounts: { pass: 1, fail: 0, waive: 0, improvement: 0, pending: 0 },
      requiredItemCount: 1,
      optionalItemCount: 0,
      evidenceCount: 0,
      nextAction: 'integrate',
      coverage: { covered: 0, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
    })
    expect(summary.durationMs).toBeGreaterThanOrEqual(0)
    expect(summary.modelCapability).toMatchObject({ imageEvidenceMode: 'references_only' })
    expect(firstEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_COMPLETE' })
    const artifact = getLatestPhaseArtifact(setup.ticket.id, 'manual_qa_summary', 'WAITING_MANUAL_QA')
    expect(JSON.parse(artifact!.content)).toMatchObject({ version: 1, outcome: 'passed' })

    const recoveryEvent = vi.fn()
    const recovered = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: recoveryEvent,
    })
    expect(recovered).toEqual(summary)
    expect(recoveryEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_COMPLETE' })

    const operationPath = getManualQaStoragePaths(setup.paths.ticketDir, 1).operationPath
    const interruptedJournal = JSON.parse(readFileSync(operationPath, 'utf8'))
    writeFileSync(operationPath, JSON.stringify({ ...interruptedJournal, state: 'creating_beads' }, null, 2))
    await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })
    expect(JSON.parse(readFileSync(operationPath, 'utf8')).state).toBe('complete')
  })

  it('repairs a missing phase summary before replaying a canonical terminal outcome', async () => {
    const setup = prepareFixture()
    persistManualQaSummary(setup.paths.ticketDir, terminalSummary(setup, 'passed'))

    const sendEvent = vi.fn()
    await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent,
    })

    const artifact = getLatestPhaseArtifact(setup.ticket.id, 'manual_qa_summary', 'WAITING_MANUAL_QA')
    expect(JSON.parse(artifact!.content)).toMatchObject({ version: 1, outcome: 'passed' })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_COMPLETE' })
  })

  it('repairs missing skip and summary phase artifacts after a terminal skip crash window', async () => {
    const setup = prepareFixture()
    const paths = getManualQaStoragePaths(setup.paths.ticketDir, 1)
    const actionId = 'skip-crash-window'
    reserveManualQaSubmissionOperation({
      path: paths.operationPath,
      actionId,
      operationType: 'skip',
      ticketId: setup.ticket.id,
      version: 1,
      checklistHash: setup.guard.expectedChecklistHash,
      draftRevision: 1,
    })
    writeFileSync(paths.skipReceiptPath, [
      'schemaVersion: 1',
      'artifact: manual_qa_skip_receipt',
      `ticketId: ${JSON.stringify(setup.ticket.externalId)}`,
      'version: 1',
      `actionId: ${JSON.stringify(actionId)}`,
      'reason: "Recovered skip"',
      'createdAt: "2026-07-13T12:01:00.000Z"',
      '',
    ].join('\n'))
    persistManualQaSummary(setup.paths.ticketDir, terminalSummary(setup, 'skipped', 'Recovered skip'))

    const sendEvent = vi.fn()
    await skipManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: { ...setup.guard, actionId, operationType: 'skip' },
      reason: 'Recovered skip',
      sendEvent,
    })

    expect(JSON.parse(getLatestPhaseArtifact(
      setup.ticket.id,
      'manual_qa_summary',
      'WAITING_MANUAL_QA',
    )!.content)).toMatchObject({ version: 1, outcome: 'skipped' })
    expect(JSON.parse(getLatestPhaseArtifact(
      setup.ticket.id,
      'manual_qa_skip_receipt',
      'WAITING_MANUAL_QA',
    )!.content)).toMatchObject({ actionId, version: 1, reason: 'Recovered skip' })
    expect(JSON.parse(readFileSync(paths.operationPath, 'utf8')).state).toBe('complete')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_SKIPPED' })
  })

  it('rejects a conflicting operation before writing canonical submission results', async () => {
    const setup = prepareFixture()
    const paths = getManualQaStoragePaths(setup.paths.ticketDir, 1)
    reserveManualQaSubmissionOperation({
      path: paths.operationPath,
      actionId: 'another-action',
      operationType: 'submit',
      ticketId: setup.ticket.id,
      version: 1,
      checklistHash: setup.guard.expectedChecklistHash,
      draftRevision: 1,
    })

    await expect(submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })).rejects.toThrow('different input')
    expect(existsSync(paths.resultsPath)).toBe(false)
  })

  it('rejects invalid action IDs before reserving an operation', async () => {
    const setup = prepareFixture()
    const operationPath = getManualQaStoragePaths(setup.paths.ticketDir, 1).operationPath
    await expect(submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: { ...setup.guard, actionId: 'invalid action id' },
      sendEvent: vi.fn(),
    })).rejects.toThrow('valid action ID')
    expect(existsSync(operationPath)).toBe(false)
  })

  it('reuses the immutable canonical results snapshot on a partial-operation retry', async () => {
    const setup = prepareFixture()
    const paths = getManualQaStoragePaths(setup.paths.ticketDir, 1)
    reserveManualQaSubmissionOperation({
      path: paths.operationPath,
      actionId: setup.guard.actionId,
      operationType: 'submit',
      ticketId: setup.ticket.id,
      version: 1,
      checklistHash: setup.guard.expectedChecklistHash,
      draftRevision: 1,
    })
    persistManualQaResults(setup.paths.ticketDir, {
      ...setup.draft,
      artifact: 'manual_qa_results',
      actionId: setup.guard.actionId,
      submittedAt: '2026-07-13T12:00:00.000Z',
    })

    await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })
    expect(readManualQaResults(setup.paths.ticketDir, 1)?.submittedAt).toBe('2026-07-13T12:00:00.000Z')
  })

  it('supports a required waiver without a reason, optional pending, and skip completion paths', async () => {
    const waived = prepareFixture()
    waived.draft.results[0] = { ...waived.draft.results[0]!, outcome: 'waive', reason: '' }
    expect(await submitManualQa({
      ticketId: waived.ticket.id,
      version: 1,
      draft: waived.draft,
      guard: waived.guard,
      sendEvent: vi.fn(),
    })).toMatchObject({
      outcome: 'waived_through',
      waivedItemIds: ['item-one'],
      waivedItems: [{ itemId: 'item-one', reason: '' }],
    })

    const optional = prepareFixture([checklistItem('optional-pending', false)])
    optional.draft.results[0] = { ...optional.draft.results[0]!, outcome: 'pending' }
    expect((await submitManualQa({
      ticketId: optional.ticket.id,
      version: 1,
      draft: optional.draft,
      guard: optional.guard,
      sendEvent: vi.fn(),
    })).outcome).toBe('passed')

    const skipped = prepareFixture()
    const skipEvent = vi.fn()
    const skippedSummary = await skipManualQa({
      ticketId: skipped.ticket.id,
      version: 1,
      draft: skipped.draft,
      guard: { ...skipped.guard, actionId: 'skip-one', operationType: 'skip' },
      reason: 'Verified separately.',
      sendEvent: skipEvent,
    })
    expect(skippedSummary).toMatchObject({
      outcome: 'skipped',
      skipReason: 'Verified separately.',
      modelCapability: { imageEvidenceMode: 'references_only' },
    })
    expect(skipEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_SKIPPED' })
  })


  it('stores no reason as null and reads the skip back through the shared audit trail', async () => {
    const setup = prepareFixture()
    await skipManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: { ...setup.guard, actionId: 'skip-no-reason', operationType: 'skip' },
      sendEvent: vi.fn(),
    })

    const artifact = getLatestPhaseArtifact(setup.ticket.id, 'manual_qa_skip_receipt', 'WAITING_MANUAL_QA')
    expect(JSON.parse(artifact!.content).reason).toBeNull()

    // Manual QA already writes five records for one skip. The shared read API is
    // an adapter over those, not a sixth record.
    const events = listSkipEvents(setup.ticket.id)
    const roundSkip = events.find((event) => event.surface === 'manual_qa')
    expect(roundSkip).toMatchObject({ itemType: 'manual_qa_round', reason: null })
    expect(events.filter((event) => event.surface === 'manual_qa')).toHaveLength(1)
  })

  it.each([
    { outcome: 'pass', expectedSummaryOutcome: 'passed' },
    { outcome: 'waive', expectedSummaryOutcome: 'waived_through' },
  ] as const)('drops stale optional evidence references for $outcome while retaining stored evidence', async ({
    outcome,
    expectedSummaryOutcome,
  }) => {
    const setup = prepareFixture()
    const evidence = await streamManualQaEvidence({
      ticketDir: setup.paths.ticketDir,
      version: 1,
      itemId: 'item-one',
      evidenceId: 'evidence-valid',
      originalName: 'result.png',
      mediaType: 'image/png',
      body: byteStream(new TextEncoder().encode('stored evidence')),
    })
    setup.draft.evidence = [evidence]
    setup.draft.results[0] = {
      ...setup.draft.results[0]!,
      outcome,
      evidenceIds: [evidence.id, 'evidence:stale-upload'],
    }

    const summary = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })

    expect(summary).toMatchObject({
      outcome: expectedSummaryOutcome,
      evidenceCount: 1,
    })
    expect(readManualQaResults(setup.paths.ticketDir, 1)?.results[0]?.evidenceIds).toEqual([
      evidence.id,
    ])
  })

  it('skips with incomplete Fail and Improvement data while preserving the draft and creating no work', async () => {
    const setup = prepareFixture([
      checklistItem('incomplete-failure'),
      checklistItem('incomplete-improvement'),
    ])
    setup.draft.results = [
      {
        ...setup.draft.results[0]!,
        itemId: 'incomplete-failure',
        outcome: 'fail',
        observation: '',
      },
      {
        ...setup.draft.results[1]!,
        itemId: 'incomplete-improvement',
        outcome: 'improvement',
      },
    ]
    setup.draft.improvements = []

    const summary = await skipManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: { ...setup.guard, actionId: 'skip-incomplete-work', operationType: 'skip' },
      sendEvent: vi.fn(),
    })

    expect(summary).toMatchObject({
      outcome: 'skipped',
      createdFixBeadIds: [],
      improvementTicketIds: [],
      itemCounts: { pass: 0, fail: 1, waive: 0, improvement: 1, pending: 0 },
    })
    const snapshot = readFileSync(
      resolve(getManualQaStoragePaths(setup.paths.ticketDir, 1).versionDir, 'manual-qa-draft.yaml'),
      'utf8',
    )
    expect(snapshot).toContain('itemId: incomplete-failure')
    expect(snapshot).toContain('outcome: fail')
    expect(snapshot).toContain('itemId: incomplete-improvement')
    expect(snapshot).toContain('outcome: improvement')
    expect(readJsonl<Bead>(setup.paths.beadsPath).filter((bead) => bead.qaOrigin)).toEqual([])
  })

  it('resumes a failed round without duplicating fresh phase attempts', async () => {
    const setup = prepareFixture()
    setup.draft.results[0] = {
      ...setup.draft.results[0]!,
      outcome: 'fail',
      observation: 'The behavior did not work.',
    }
    const firstEvent = vi.fn()
    const summary = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: firstEvent,
      generateFixBeads: async () => [{
        groupId: 'item:item-one',
        title: 'Repair item one behavior',
        description: 'Correct the implementation so item one remains usable.',
        prdRefs: [],
        contextGuidance: {
          patterns: ['Follow the existing implementation boundary.'],
          anti_patterns: ['Do not mask the failure in the UI.'],
        },
        acceptanceCriteria: ['Item one works as specified.'],
        tests: ['Add an automated regression test for item one.'],
        testCommands: ['npm run test:server'],
        labels: ['manual-qa'],
        blockedByGroupIds: [],
        targetFiles: ['src/item-one.ts'],
      }],
    })
    expect(summary.outcome).toBe('created_fixes')
    const fixBead = readJsonl<Bead>(setup.paths.beadsPath).find((bead) => bead.qaOrigin)
    expect(fixBead?.qaOrigin).toMatchObject({
      modelId: null,
      modelSupportsImages: null,
      imageDelivery: 'references_only',
    })
    expect(fixBead?.qaOrigin?.createdFromManualQaAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(firstEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_FIXES_CREATED' })
    const attemptCounts = Object.fromEntries(
      ['RUNNING_FINAL_TEST', 'GENERATING_QA_CHECKLIST', 'WAITING_MANUAL_QA']
        .map((phase) => [phase, listPhaseAttempts(setup.ticket.id, phase).length]),
    )

    const recoveryEvent = vi.fn()
    await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: recoveryEvent,
    })
    expect(recoveryEvent).toHaveBeenCalledWith({ type: 'MANUAL_QA_FIXES_CREATED' })
    for (const [phase, count] of Object.entries(attemptCounts)) {
      expect(listPhaseAttempts(setup.ticket.id, phase)).toHaveLength(count)
    }
  })

  it('moves fix-bead generation failures to the error path before creating any child work', async () => {
    const setup = prepareFixture([checklistItem('failed-item'), checklistItem('improvement-item')])
    setup.draft.results = [
      {
        ...setup.draft.results[0]!,
        itemId: 'failed-item',
        outcome: 'fail',
        observation: 'The behavior is broken.',
      },
      {
        ...setup.draft.results[1]!,
        itemId: 'improvement-item',
        outcome: 'improvement',
        improvementDraftId: 'improvement-draft',
      },
    ]
    setup.draft.improvements = [{
      id: 'improvement-draft',
      itemId: 'improvement-item',
      title: 'Improve the adjacent behavior',
      description: 'Make the adjacent behavior clearer.',
      evidenceIds: [],
      priority: 4,
      manualQaEnabled: false,
    }]
    const sendEvent = vi.fn()

    await expect(submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent,
      generateFixBeads: async () => { throw new Error('invalid candidate') },
    })).rejects.toThrow('invalid candidate')

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      codes: ['MANUAL_QA_FIX_BEADS_FAILED'],
    }))
    expect(readJsonl<Bead>(setup.paths.beadsPath).filter((bead) => bead.qaOrigin)).toEqual([])
    expect(listTickets(setup.ticket.projectId).filter((entry) => entry.manualQaOrigin)).toEqual([])
    expect(JSON.parse(readFileSync(getManualQaStoragePaths(setup.paths.ticketDir, 1).operationPath, 'utf8')).state)
      .toBe('generating_beads')
    expect(existsSync(resolve(getManualQaStoragePaths(setup.paths.ticketDir, 1).versionDir, 'fix-beads.yaml'))).toBe(false)
  })

  it('rejects evidence attached to a different checklist item', async () => {
    const setup = prepareFixture([checklistItem('item-one'), checklistItem('item-two')])
    const evidence = await streamManualQaEvidence({
      ticketDir: setup.paths.ticketDir,
      version: 1,
      itemId: 'item-two',
      evidenceId: 'evidence-two',
      originalName: 'observation.txt',
      mediaType: 'text/plain',
      body: byteStream(new TextEncoder().encode('Observed item two')),
    })
    setup.draft.evidence = [evidence]
    setup.draft.results[0]!.evidenceIds = [evidence.id]

    await expect(submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })).rejects.toThrow('Item 1 Verify item-one references file "observation.txt", but that file belongs to item 2 Verify item-two.')
  })

  it('creates one restart-idempotent improvement ticket with human-readable context and structured provenance', async () => {
    const item = checklistItem('required-improvement')
    item.title = 'Remember the chosen value'
    item.behavior = 'The chosen value can be reused on a future visit'
    item.actions = ['Choose a value and reload the page']
    item.expectedResult = 'The chosen value remains selected after reload'
    item.prdRefs = [{ ref: 'EPIC-1/STORY-1/AC-1', coverage: 'full' }]
    item.beadRefs = ['source-bead']
    const setup = prepareFixture([item])
    writeFileSync(resolve(setup.paths.ticketDir, 'prd.yaml'), [
      'epics:',
      '  - id: EPIC-1',
      '    user_stories:',
      '      - id: STORY-1',
      '        title: Remember a saved preference',
      '        acceptance_criteria:',
      '          - The saved choice is restored on the next visit.',
      '',
    ].join('\n'))
    writeJsonl(setup.paths.beadsPath, [{
      id: 'source-bead',
      title: 'Persist user preferences',
      description: 'Store and restore the selected value.',
      targetFiles: ['src/preferences.ts'],
    } as Bead])
    setup.draft.results[0] = {
      ...setup.draft.results[0]!,
      outcome: 'improvement',
      note: 'Remember this choice for future visits.',
      improvementDraftId: 'improvement-one',
    }
    setup.draft.improvements = [{
      id: 'improvement-one',
      itemId: 'required-improvement',
      title: 'Persist the choice',
      description: 'Keep the chosen value after reload.',
      evidenceIds: [],
      priority: 2,
      manualQaEnabled: true,
    }]
    const summary = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })
    expect(summary.outcome).toBe('passed')
    expect(summary.improvementTicketIds).toHaveLength(1)
    const childId = summary.improvementTicketIds[0]!
    const child = getTicketByRef(childId)!
    expect(child.description).toContain('## Manual QA Context')
    expect(child.description).toContain('PRD requirement: The saved choice is restored on the next visit.')
    expect(child.description).toContain('Implementation work area: Persist user preferences')
    expect(child.description).not.toContain('required-improvement')
    expect(child.description).not.toContain('EPIC-1/STORY-1/AC-1')
    expect(child.description).not.toContain('source-bead')
    expect(child.priority).toBe(2)
    expect(child.manualQaOverride).toBe(true)
    const childPaths = getTicketPaths(childId)!
    const origin = JSON.parse(readFileSync(resolve(childPaths.ticketDir, 'meta', 'manual-qa-origin.json'), 'utf8'))
    expect(origin).toMatchObject({
      source: 'manual_qa_improvement',
      sourceItemIds: ['required-improvement'],
      resultType: 'improvement',
      evidenceRefs: [],
      priority: 2,
      manualQaEnabled: true,
    })
    const retried = await submitManualQa({
      ticketId: setup.ticket.id,
      version: 1,
      draft: setup.draft,
      guard: setup.guard,
      sendEvent: vi.fn(),
    })
    expect(retried.improvementTicketIds).toEqual([childId])
  })
})
