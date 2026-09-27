import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'
import { TEST, makeTicketContext } from '../../../test/factories'
import { handleManualQaChecklistGeneration } from '../generator'

const mocks = vi.hoisted(() => ({
  getTicketPaths: vi.fn(),
  resolvePhaseAttempt: vi.fn(),
  getLatestPhaseArtifact: vi.fn(),
  insertPhaseArtifact: vi.fn(),
  getTicketByRef: vi.fn(),
  resolveAiResponseRuntimeSettings: vi.fn(),
  resolveStructuredRetryRuntimeSettings: vi.fn(),
  emitAiMilestone: vi.fn(),
  emitOpenCodePromptLog: vi.fn(),
  emitOpenCodeSessionLogs: vi.fn(),
  emitOpenCodeStreamEvent: vi.fn(),
  prepareManualQaCheckpoint: vi.fn(),
  deriveManualQaPrdCriteria: vi.fn(),
  computeManualQaCoverage: vi.fn(),
  readManualQaPrd: vi.fn(),
  parseManualQaChecklistOutput: vi.fn(),
  allocateNextManualQaVersion: vi.fn(),
  appendManualQaEvent: vi.fn(),
  completeManualQaReservation: vi.fn(),
  getManualQaChecklistHash: vi.fn(),
  listManualQaVersions: vi.fn(),
  persistManualQaChecklist: vi.fn(),
  persistManualQaCoverage: vi.fn(),
  readManualQaChecklist: vi.fn(),
  readManualQaCoverage: vi.fn(),
  readManualQaResults: vi.fn(),
  readManualQaSummary: vi.fn(),
  reserveManualQaVersion: vi.fn(),
  focusedDiffMetadata: vi.fn(),
  readBeadsFile: vi.fn(),
  runOpenCodePrompt: vi.fn(),
  persistUiArtifactCompanionArtifact: vi.fn(),
}))

vi.mock('../../../storage/tickets', () => ({
  getLatestPhaseArtifact: mocks.getLatestPhaseArtifact,
  getTicketByRef: mocks.getTicketByRef,
  getTicketPaths: mocks.getTicketPaths,
  insertPhaseArtifact: mocks.insertPhaseArtifact,
  resolvePhaseAttempt: mocks.resolvePhaseAttempt,
}))
vi.mock('../../../workflow/phases/state', () => ({ adapter: {} }))
vi.mock('../../../workflow/phases/helpers', () => ({
  createOpenCodeStreamState: () => ({}),
  emitAiMilestone: mocks.emitAiMilestone,
  emitOpenCodePromptLog: mocks.emitOpenCodePromptLog,
  emitOpenCodeSessionLogs: mocks.emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent: mocks.emitOpenCodeStreamEvent,
  resolveAiResponseRuntimeSettings: mocks.resolveAiResponseRuntimeSettings,
  resolveStructuredRetryRuntimeSettings: mocks.resolveStructuredRetryRuntimeSettings,
}))
vi.mock('../../../workflow/runOpenCodePrompt', () => ({ runOpenCodePrompt: mocks.runOpenCodePrompt }))
vi.mock('../../../phases/beads/beadsFile', () => ({ readBeadsFile: mocks.readBeadsFile }))
vi.mock('../../../workflow/artifactCompanions', () => ({
  persistUiArtifactCompanionArtifact: mocks.persistUiArtifactCompanionArtifact,
}))
vi.mock('../checkpoint', () => ({ prepareManualQaCheckpoint: mocks.prepareManualQaCheckpoint }))
vi.mock('../coverage', () => ({
  computeManualQaCoverage: mocks.computeManualQaCoverage,
  deriveManualQaPrdCriteria: mocks.deriveManualQaPrdCriteria,
}))
vi.mock('../prd', () => ({ readManualQaPrd: mocks.readManualQaPrd }))
vi.mock('../parser', () => ({
  MANUAL_QA_CHECKLIST_TAG: 'MANUAL_QA_CHECKLIST',
  parseManualQaChecklistOutput: mocks.parseManualQaChecklistOutput,
}))
vi.mock('../storage', () => ({
  allocateNextManualQaVersion: mocks.allocateNextManualQaVersion,
  appendManualQaEvent: mocks.appendManualQaEvent,
  completeManualQaReservation: mocks.completeManualQaReservation,
  getManualQaChecklistHash: mocks.getManualQaChecklistHash,
  listManualQaVersions: mocks.listManualQaVersions,
  persistManualQaChecklist: mocks.persistManualQaChecklist,
  persistManualQaCoverage: mocks.persistManualQaCoverage,
  readManualQaChecklist: mocks.readManualQaChecklist,
  readManualQaCoverage: mocks.readManualQaCoverage,
  readManualQaResults: mocks.readManualQaResults,
  readManualQaSummary: mocks.readManualQaSummary,
  reserveManualQaVersion: mocks.reserveManualQaVersion,
}))
vi.mock('../focusedDiff', () => ({ focusedDiffMetadata: mocks.focusedDiffMetadata }))

const roots: string[] = []
const ticketContext = makeTicketContext({
  title: 'Test the filter behavior',
  lockedMainImplementer: TEST.implementer,
  lockedMainImplementerVariant: 'fast',
})
const checklist = {
  schemaVersion: 1,
  artifact: 'manual_qa_checklist',
  ticketId: TEST.externalId,
  version: 1,
  generatedAt: TEST.timestamp,
  summary: 'Verify the filter behavior.',
  notApplicablePrdRefs: [],
  items: [],
}
const coverage = { coveredCount: 1, uncoveredCount: 0 }

function successfulParse() {
  mocks.parseManualQaChecklistOutput.mockReturnValue({
    ok: true,
    value: checklist,
    normalizedContent: 'summary: Verify the filter behavior.',
    repairApplied: false,
    repairWarnings: [],
  })
}

function failureParse(error = 'Checklist did not match the schema.') {
  mocks.parseManualQaChecklistOutput.mockReturnValue({
    ok: false,
    error,
    retryDiagnostic: { category: 'invalid_shape' },
  })
}

beforeEach(() => {
  const ticketDir = makeTempDir('looptroop-manual-qa-generation-flow-')
  roots.push(ticketDir)
  vi.clearAllMocks()
  mocks.getTicketPaths.mockReturnValue({
    ticketDir,
    worktreePath: `${ticketDir}/worktree`,
    beadsPath: `${ticketDir}/beads.jsonl`,
  })
  mocks.resolvePhaseAttempt.mockReturnValue(1)
  mocks.getLatestPhaseArtifact.mockReturnValue(null)
  mocks.getTicketByRef.mockReturnValue({
    description: 'Keep the selected filter between visits.',
    runtime: { baseBranch: 'main' },
  })
  mocks.resolveAiResponseRuntimeSettings.mockReturnValue({ timeoutMs: 15_000 })
  mocks.resolveStructuredRetryRuntimeSettings.mockReturnValue({ structuredRetryCount: 1 })
  mocks.prepareManualQaCheckpoint.mockResolvedValue(undefined)
  mocks.deriveManualQaPrdCriteria.mockReturnValue([])
  mocks.computeManualQaCoverage.mockReturnValue(coverage)
  mocks.readManualQaPrd.mockReturnValue({ epics: [] })
  mocks.allocateNextManualQaVersion.mockReturnValue(1)
  mocks.reserveManualQaVersion.mockReturnValue({ actionId: 'generation:one', createdAt: TEST.timestamp })
  mocks.listManualQaVersions.mockReturnValue([])
  mocks.readManualQaChecklist.mockReturnValue(null)
  mocks.readManualQaCoverage.mockReturnValue(null)
  mocks.readManualQaResults.mockReturnValue(null)
  mocks.readManualQaSummary.mockReturnValue(null)
  mocks.persistManualQaChecklist.mockReturnValue('a'.repeat(64))
  mocks.getManualQaChecklistHash.mockReturnValue('a'.repeat(64))
  mocks.readBeadsFile.mockReturnValue([])
  mocks.focusedDiffMetadata.mockReturnValue('No candidate diff.')
  mocks.runOpenCodePrompt.mockResolvedValue({
    session: { id: 'session-1' },
    response: '<MANUAL_QA_CHECKLIST>summary: ready</MANUAL_QA_CHECKLIST>',
    messages: [],
  })
  successfulParse()
})

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
})

describe('Manual QA generation orchestration', () => {
  it('persists a first-pass checklist and sends the ready event', async () => {
    const sendEvent = vi.fn()

    await handleManualQaChecklistGeneration(TEST.ticketId, ticketContext, sendEvent)

    expect(mocks.prepareManualQaCheckpoint).toHaveBeenCalledWith(TEST.ticketId, 1)
    expect(mocks.runOpenCodePrompt).toHaveBeenCalledWith(expect.objectContaining({
      model: TEST.implementer,
      variant: 'fast',
      toolPolicy: 'read_only',
      timeoutKind: 'ai_response',
    }))
    expect(mocks.persistManualQaChecklist).toHaveBeenCalledWith(expect.any(String), checklist)
    expect(mocks.persistManualQaCoverage).toHaveBeenCalledWith(expect.any(String), coverage)
    expect(mocks.completeManualQaReservation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actionId: 'generation:one' }),
      'a'.repeat(64),
    )
    expect(mocks.persistUiArtifactCompanionArtifact).toHaveBeenCalledWith(
      TEST.ticketId,
      'GENERATING_QA_CHECKLIST',
      'manual_qa_checklist',
      expect.objectContaining({ parsed: checklist }),
    )
    expect(sendEvent).toHaveBeenCalledWith({ type: 'QA_CHECKLIST_READY' })
  })

  it('retries invalid structured output with the validation error and records the retry', async () => {
    const sendEvent = vi.fn()
    failureParse('One tagged document is required.')
    mocks.parseManualQaChecklistOutput.mockReturnValueOnce({
      ok: false,
      error: 'One tagged document is required.',
      retryDiagnostic: { category: 'missing_tag' },
    }).mockReturnValueOnce({
      ok: true,
      value: checklist,
      normalizedContent: 'summary: repaired',
      repairApplied: true,
      repairWarnings: ['Quoted a YAML-sensitive value.'],
    })

    await handleManualQaChecklistGeneration(TEST.ticketId, ticketContext, sendEvent)

    expect(mocks.runOpenCodePrompt).toHaveBeenCalledTimes(2)
    expect(mocks.runOpenCodePrompt.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      parts: [expect.objectContaining({ content: expect.stringContaining('One tagged document is required.') })],
      sessionOwnership: expect.objectContaining({ step: 'structured-retry-1', forceFresh: true }),
    }))
    expect(mocks.persistUiArtifactCompanionArtifact).toHaveBeenCalledWith(
      TEST.ticketId,
      'GENERATING_QA_CHECKLIST',
      'manual_qa_checklist',
      expect.objectContaining({
        structuredOutput: expect.objectContaining({ autoRetryCount: 1, repairApplied: true }),
      }),
    )
    expect(sendEvent).toHaveBeenCalledWith({ type: 'QA_CHECKLIST_READY' })
  })

  it('keeps failure diagnostics when every structured-output attempt is invalid', async () => {
    const sendEvent = vi.fn()
    failureParse()

    await expect(handleManualQaChecklistGeneration(TEST.ticketId, ticketContext, sendEvent))
      .rejects.toThrow('Checklist did not match the schema.')

    expect(mocks.runOpenCodePrompt).toHaveBeenCalledTimes(2)
    expect(mocks.persistUiArtifactCompanionArtifact).toHaveBeenCalledWith(
      TEST.ticketId,
      'GENERATING_QA_CHECKLIST',
      'manual_qa_checklist',
      expect.objectContaining({
        validationError: 'Checklist did not match the schema.',
        structuredOutput: expect.objectContaining({ autoRetryCount: 1 }),
      }),
    )
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mocks.persistManualQaChecklist).not.toHaveBeenCalled()
  })

  it('restores persisted checklist artifacts without starting another model session', async () => {
    const sendEvent = vi.fn()
    mocks.readManualQaChecklist.mockReturnValue(checklist)
    mocks.readManualQaCoverage.mockReturnValue(coverage)

    await handleManualQaChecklistGeneration(TEST.ticketId, {
      ...ticketContext,
      lockedMainImplementer: undefined,
    }, sendEvent)

    expect(mocks.completeManualQaReservation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actionId: 'generation:one' }),
      'a'.repeat(64),
    )
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'QA_CHECKLIST_READY' })
  })

  it('requires the main implementer model when there is nothing to restore', async () => {
    await expect(handleManualQaChecklistGeneration(TEST.ticketId, {
      ...ticketContext,
      lockedMainImplementer: undefined,
    }, vi.fn())).rejects.toThrow('requires the locked main implementer model')

    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
  })
})
