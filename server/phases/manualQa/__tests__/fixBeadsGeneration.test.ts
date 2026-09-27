import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST, makeTicketContext } from '../../../test/factories'
import type { Bead } from '../../beads/types'
import type { ManualQaChecklist, ManualQaDraft, ManualQaEvidenceRef } from '../types'
import { generateManualQaFixBeadCandidates } from '../fixBeads'

const mocks = vi.hoisted(() => ({
  getTicketPaths: vi.fn(),
  getTicketByRef: vi.fn(),
  getLatestPhaseArtifact: vi.fn(),
  resolvePhaseAttempt: vi.fn(),
  resolveAiResponseRuntimeSettings: vi.fn(),
  resolveStructuredRetryRuntimeSettings: vi.fn(),
  emitAiMilestone: vi.fn(),
  emitOpenCodePromptLog: vi.fn(),
  emitOpenCodeSessionLogs: vi.fn(),
  emitOpenCodeStreamEvent: vi.fn(),
  runOpenCodePrompt: vi.fn(),
  readManualQaPrd: vi.fn(),
  focusedDiffMetadata: vi.fn(),
}))

vi.mock('../../../storage/tickets', () => ({
  getTicketPaths: mocks.getTicketPaths,
  getTicketByRef: mocks.getTicketByRef,
  getLatestPhaseArtifact: mocks.getLatestPhaseArtifact,
  resolvePhaseAttempt: mocks.resolvePhaseAttempt,
}))
vi.mock('../../../workflow/phases/state', () => ({ adapter: { name: 'test-adapter' } }))
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
vi.mock('../prd', () => ({ readManualQaPrd: mocks.readManualQaPrd }))
vi.mock('../focusedDiff', () => ({ focusedDiffMetadata: mocks.focusedDiffMetadata }))

const checklist: ManualQaChecklist = {
  schemaVersion: 1,
  artifact: 'manual_qa_checklist',
  ticketId: TEST.externalId,
  version: 1,
  generatedAt: TEST.timestamp,
  summary: 'Verify preference persistence.',
  notApplicablePrdRefs: [],
  items: [{
    id: 'qa-v1-001',
    lineageId: 'saved-preference',
    priorItemIds: [],
    title: 'Saved preference',
    source: 'prd',
    behavior: 'A saved preference remains selected.',
    severity: 'required',
    recheckState: 'new',
    prerequisites: [],
    actions: ['Save and reload.'],
    expectedResult: 'The preference remains selected.',
    watchNotes: [],
    beadRefs: [],
    prdRefs: [{ ref: 'EPIC-1/STORY-1/AC-1', coverage: 'full' }],
  }],
}

const evidenceRef: ManualQaEvidenceRef = {
  id: 'evidence-1',
  itemId: 'qa-v1-001',
  originalName: 'reload-reset.png',
  storedName: 'evidence-1.png',
  mediaType: 'image/png',
  size: 128,
  sha256: 'b'.repeat(64),
  inlinePreview: false,
  createdAt: TEST.timestamp,
}

const draft: ManualQaDraft = {
  schemaVersion: 1,
  artifact: 'manual_qa_draft',
  ticketId: TEST.externalId,
  version: 1,
  checklistHash: 'a'.repeat(64),
  draftRevision: 1,
  results: [{
    itemId: 'qa-v1-001',
    outcome: 'fail',
    note: 'The reload path loses the saved choice.',
    observation: 'The preference resets after reload.',
    reason: '',
    evidenceIds: ['evidence-1'],
    links: [],
  }],
  improvements: [],
  evidence: [],
  updatedAt: TEST.timestamp,
}

const existingBead = {
  id: 'existing-bead',
  title: 'Save selected preference',
  description: 'Persist and restore the selected preference.',
  prdRefs: ['EPIC-1/STORY-1/AC-1'],
  contextGuidance: { patterns: ['Use the preference store.'], anti_patterns: ['Do not add another store.'] },
  acceptanceCriteria: ['Reloading keeps the selection.'],
  tests: ['Test reload persistence.'],
  testCommands: [],
  testCommandReason: 'The current project has no automated test command for this check.',
  labels: ['preferences'],
  dependencies: { blocked_by: [], blocks: [] },
  targetFiles: ['src/preferences/store.ts'],
} as Bead

const response = `<MANUAL_QA_FIX_BEADS>
beads:
  - groupId: "item:qa-v1-001"
    title: "Restore saved preference"
    description: "Restore the selected preference after the page reloads."
    prdRefs: ["EPIC-1/STORY-1/AC-1"]
    contextGuidance:
      patterns: ["Use the existing preference store."]
      anti_patterns: ["Do not add a second persistence layer."]
    acceptanceCriteria: ["Reloading preserves the selected value."]
    tests: ["Add a reload persistence regression test."]
    testCommands: []
    testCommandReason: "The fix has a user-driven check in addition to automated coverage."
    labels: ["preferences"]
    blockedByGroupIds: []
    targetFiles: ["src/preferences/store.ts"]
</MANUAL_QA_FIX_BEADS>`

const input = () => ({
  ticketId: TEST.ticketId,
  context: makeTicketContext({
    lockedMainImplementer: TEST.implementer,
    lockedMainImplementerVariant: 'fast',
  }),
  checklist,
  draft,
  evidence: [evidenceRef],
  existingBeads: [existingBead],
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getTicketPaths.mockReturnValue({ ticketDir: '/ticket', worktreePath: '/repo', beadsPath: '/ticket/beads.jsonl' })
  mocks.getTicketByRef.mockReturnValue({
    description: 'Persist the selected preference between visits.',
    runtime: { baseBranch: 'main' },
  })
  mocks.getLatestPhaseArtifact.mockReturnValue({ content: 'Automated checks passed.' })
  mocks.resolvePhaseAttempt.mockReturnValue(3)
  mocks.resolveAiResponseRuntimeSettings.mockReturnValue({ timeoutMs: 12_000 })
  mocks.resolveStructuredRetryRuntimeSettings.mockReturnValue({ structuredRetryCount: 1 })
  mocks.readManualQaPrd.mockReturnValue({ epics: [], raw: 'epics: []\n' })
  mocks.focusedDiffMetadata.mockReturnValue('M src/preferences/store.ts')
})

describe('Manual QA fix-bead generation', () => {
  it('builds a grounded prompt, repairs an invalid response, and accepts candidates after repository inspection', async () => {
    mocks.runOpenCodePrompt
      .mockResolvedValueOnce({
        session: { id: 'fix-beads-1' },
        response: 'not tagged YAML',
        messages: [{
          id: 'message-1',
          role: 'assistant',
          parts: [{
            id: 'part-1',
            sessionID: 'fix-beads-1',
            messageID: 'message-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'read',
            state: { status: 'completed', input: { path: 'src/preferences/store.ts' } },
          }],
        }],
      })
      .mockImplementationOnce(async (options) => {
        options.onSessionCreated?.({ id: 'fix-beads-2' })
        options.onPromptDispatched?.({
          session: { id: 'fix-beads-2' },
          parts: [{ type: 'text', content: 'fix-bead prompt' }],
          promptText: 'fix-bead prompt',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        })
        options.onStreamEvent?.({
          type: 'tool',
          sessionId: 'fix-beads-2',
          tool: 'read',
          callId: 'call-2',
          status: 'completed',
          input: { filePath: 'src/preferences/store.ts' },
          complete: true,
        })
        return { session: { id: 'fix-beads-2' }, response, messages: [] }
      })

    const candidates = await generateManualQaFixBeadCandidates(input())

    expect(candidates).toMatchObject([{
      groupId: 'item:qa-v1-001',
      title: 'Restore saved preference',
      prdRefs: ['EPIC-1/STORY-1/AC-1'],
      targetFiles: ['src/preferences/store.ts'],
    }])
    expect(mocks.runOpenCodePrompt).toHaveBeenCalledTimes(2)
    expect(mocks.runOpenCodePrompt.mock.calls[0]?.[0]).toMatchObject({
      projectPath: '/repo',
      timeoutMs: 12_000,
      timeoutKind: 'ai_response',
      model: TEST.implementer,
      variant: 'fast',
      sessionOwnership: {
        ticketId: TEST.ticketId,
        phase: 'WAITING_MANUAL_QA',
        phaseAttempt: 3,
        memberId: TEST.implementer,
        step: 'generate-fix-beads',
        forceFresh: false,
      },
    })
    expect(mocks.runOpenCodePrompt.mock.calls[1]?.[0]).toMatchObject({
      sessionOwnership: { step: 'fix-beads-structured-retry-1', forceFresh: true },
    })
    const prompt = mocks.runOpenCodePrompt.mock.calls[0]?.[0]?.parts[0]?.content ?? ''
    const retryPrompt = mocks.runOpenCodePrompt.mock.calls[1]?.[0]?.parts[0]?.content ?? ''
    expect(prompt).toContain('Persist the selected preference between visits.')
    expect(prompt).toContain('epics: []')
    expect(prompt).toContain('Automated checks passed.')
    expect(prompt).toContain('The preference resets after reload.')
    expect(prompt).toContain('reload-reset.png')
    expect(prompt).toContain('b'.repeat(64))
    expect(prompt).toContain('Save selected preference')
    expect(prompt).toContain('The current project has no automated test command for this check.')
    expect(prompt).toContain('M src/preferences/store.ts')
    expect(retryPrompt).toContain('Expected exactly one complete <MANUAL_QA_FIX_BEADS> tagged YAML response.')
    expect(mocks.emitOpenCodePromptLog).toHaveBeenCalledOnce()
    expect(mocks.emitOpenCodeStreamEvent).toHaveBeenCalledOnce()
    expect(mocks.emitOpenCodeSessionLogs).toHaveBeenCalledTimes(2)
    expect(mocks.emitAiMilestone).toHaveBeenCalledWith(
      TEST.ticketId,
      TEST.externalId,
      'WAITING_MANUAL_QA',
      'Validated 1 Manual QA fix bead candidate.',
      'fix-beads-validated',
    )
  })

  it('returns no candidates without prompting when the draft has no failures', async () => {
    const noFailures = { ...input(), draft: { ...draft, results: [{ ...draft.results[0]!, outcome: 'pass' as const }] } }

    await expect(generateManualQaFixBeadCandidates(noFailures)).resolves.toEqual([])
    expect(mocks.readManualQaPrd).not.toHaveBeenCalled()
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
  })

  it('fails early when ticket storage or the locked implementer is missing', async () => {
    mocks.getTicketPaths.mockReturnValueOnce(null)
    await expect(generateManualQaFixBeadCandidates(input())).rejects.toThrow('Ticket storage was not found')

    mocks.getTicketByRef.mockReturnValueOnce(null)
    await expect(generateManualQaFixBeadCandidates(input())).rejects.toThrow('Ticket storage was not found')

    await expect(generateManualQaFixBeadCandidates({
      ...input(),
      context: makeTicketContext({ lockedMainImplementer: undefined }),
    })).rejects.toThrow('requires the locked main implementer model')
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
  })

  it('does not accept a syntactically valid response without completed repository inspection', async () => {
    mocks.resolveStructuredRetryRuntimeSettings.mockReturnValue({ structuredRetryCount: 0 })
    mocks.runOpenCodePrompt.mockResolvedValue({ session: { id: 'fix-beads-no-inspection' }, response, messages: [] })

    await expect(generateManualQaFixBeadCandidates(input())).rejects.toThrow(
      'The model did not complete the required read-only repository inspection tool call.',
    )
    expect(mocks.emitAiMilestone).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('Validated'),
      'fix-beads-validated',
    )
  })
})
