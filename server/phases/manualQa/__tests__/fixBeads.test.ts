import { describe, expect, it } from 'vitest'
import {
  buildManualQaFixGroups,
  hydrateManualQaFixBeads,
  hasSuccessfulManualQaRepositoryToolCall,
  parseManualQaFixBeadsOutput,
} from '../fixBeads'
import type { ManualQaChecklist, ManualQaDraft, ManualQaModelCapabilitySnapshot } from '../types'
import type { Message } from '../../../opencode/types'

const checklist: ManualQaChecklist = {
  schemaVersion: 1,
  artifact: 'manual_qa_checklist',
  ticketId: 'TEST-1',
  version: 1,
  generatedAt: '2026-07-14T08:00:00.000Z',
  summary: 'Verify the change.',
  notApplicablePrdRefs: [],
  items: [{
    id: 'qa-v1-001',
    lineageId: 'saved-value',
    priorItemIds: [],
    title: 'Saved value',
    source: 'prd',
    behavior: 'The saved value remains selected.',
    severity: 'required',
    recheckState: 'new',
    prerequisites: [],
    actions: ['Save and reload.'],
    expectedResult: 'The value remains selected.',
    watchNotes: [],
    beadRefs: ['existing-bead'],
    prdRefs: [{ ref: 'EPIC-1/STORY-1/AC-1', coverage: 'full' }],
  }],
}

const draft: ManualQaDraft = {
  schemaVersion: 1,
  artifact: 'manual_qa_draft',
  ticketId: 'TEST-1',
  version: 1,
  checklistHash: 'a'.repeat(64),
  draftRevision: 1,
  results: [{
    itemId: 'qa-v1-001',
    outcome: 'fail',
    note: '',
    observation: 'The selection was cleared.',
    reason: '',
    evidenceIds: [],
    links: [],
  }],
  improvements: [],
  evidence: [],
  updatedAt: '2026-07-14T08:01:00.000Z',
}

const validResponse = `<MANUAL_QA_FIX_BEADS>
beads:
  - groupId: "item:qa-v1-001"
    title: "Restore saved selection"
    description: "Repair persistence and restore the saved selection during initialization."
    prdRefs: ["EPIC-1/STORY-1/AC-1"]
    contextGuidance:
      patterns: ["Use the existing preference storage abstraction."]
      anti_patterns: ["Do not add a second storage mechanism."]
    acceptanceCriteria: ["Reloading preserves the selected value."]
    tests: ["Add a regression test for save and reload."]
    testCommands: ["npm run test:client"]
    labels: ["preferences"]
    blockedByGroupIds: []
    targetFiles: ["src/preferences/store.ts", "src/preferences/store.test.ts"]
</MANUAL_QA_FIX_BEADS>`

describe('Manual QA fix-bead generation contracts', () => {
  it('accepts only a completed repository tool call as inspection evidence', () => {
    const message = (status: 'running' | 'completed' | 'error'): Message[] => [{
      id: 'message-one',
      role: 'assistant',
      parts: [{
        id: 'part-one',
        sessionID: 'session-one',
        messageID: 'message-one',
        type: 'tool',
        callID: 'call-one',
        tool: 'read',
        state: { status },
      }],
    }]
    expect(hasSuccessfulManualQaRepositoryToolCall(message('running'))).toBe(false)
    expect(hasSuccessfulManualQaRepositoryToolCall(message('error'))).toBe(false)
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed'))).toBe(true)
  })

  it('parses complete candidates and hydrates all normal bead fields with app-owned identity', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const candidates = parseManualQaFixBeadsOutput(validResponse, groups)
    const capability: ManualQaModelCapabilitySnapshot = {
      schemaVersion: 1,
      artifact: 'manual_qa_model_capability',
      ticketId: 'TEST-1',
      version: 1,
      modelId: 'provider/model',
      modelVariant: null,
      capabilityLookup: 'available',
      supportsImages: false,
      imageEvidenceMode: 'references_only',
      capturedAt: '2026-07-14T08:02:00.000Z',
    }
    const [bead] = hydrateManualQaFixBeads({
      candidates,
      groups,
      existing: [],
      checklist,
      evidence: [],
      ticketId: '1:TEST-1',
      externalId: 'TEST-1',
      version: 1,
      actionId: 'manual-qa-submit:one',
      modelCapability: capability,
    })
    expect(bead).toMatchObject({
      title: 'Restore saved selection',
      issueType: 'qa-fix',
      status: 'pending',
      externalRef: 'TEST-1',
      testCommands: [{
        mode: 'shell',
        shell: 'posix',
        script: 'npm run test:client',
        cwd: '.',
        env: {},
      }],
      targetFiles: ['src/preferences/store.ts', 'src/preferences/store.test.ts'],
      dependencies: { blocked_by: [], blocks: [] },
      qaOrigin: { actionId: 'manual-qa-submit:one', sourceItems: [{ itemId: 'qa-v1-001' }] },
    })
    expect(bead?.id).toMatch(/^qa-v1-[a-f0-9]{12}$/)
  })

  it('accepts a zero-command fix bead with a reason and preserves it during hydration', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const response = validResponse.replace(
      '    testCommands: ["npm run test:client"]',
      '    testCommands: []\n    testCommandReason: "This repair has only an interactive Manual QA check."',
    )
    const candidates = parseManualQaFixBeadsOutput(response, groups)
    expect(candidates[0]).toMatchObject({
      testCommands: [],
      testCommandReason: 'This repair has only an interactive Manual QA check.',
    })

    const [bead] = hydrateManualQaFixBeads({
      candidates,
      groups,
      existing: [],
      checklist,
      evidence: [],
      ticketId: '1:TEST-1',
      externalId: 'TEST-1',
      version: 1,
      actionId: 'manual-qa-submit:no-command',
      modelCapability: {
        schemaVersion: 1,
        artifact: 'manual_qa_model_capability',
        ticketId: 'TEST-1',
        version: 1,
        modelId: 'provider/model',
        modelVariant: null,
        capabilityLookup: 'available',
        supportsImages: false,
        imageEvidenceMode: 'references_only',
        capturedAt: '2026-07-14T08:02:00.000Z',
      },
    })
    expect(bead).toMatchObject({ testCommands: [], testCommandReason: 'This repair has only an interactive Manual QA check.' })
  })

  it('rejects zero-command fix beads without a reason and reasons alongside commands', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    expect(() => parseManualQaFixBeadsOutput(
      validResponse.replace('    testCommands: ["npm run test:client"]', '    testCommands: []'),
      groups,
    )).toThrow('testCommandReason')
    expect(() => parseManualQaFixBeadsOutput(
      validResponse.replace(
        '    testCommands: ["npm run test:client"]',
        '    testCommands: ["npm run test:client"]\n    testCommandReason: "Not allowed with commands."',
      ),
      groups,
    )).toThrow('testCommandReason')
  })

  it('repairs wrapped colon-containing acceptance criteria in generated fix beads', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const response = validResponse.replace(
      '    acceptanceCriteria: ["Reloading preserves the selected value."]',
      [
        '    acceptanceCriteria:',
        '      - `Object.getOwnPropertyDescriptor(fn, key)` reports `writable: false`, and',
        '        `configurable: false`.',
      ].join('\n'),
    )

    const candidates = parseManualQaFixBeadsOutput(response, groups)

    expect(candidates[0]?.acceptanceCriteria).toEqual([
      '`Object.getOwnPropertyDescriptor(fn, key)` reports `writable: false`, and `configurable: false`.',
    ])
  })

  it('rejects missing groups, invented PRD refs, unsafe paths, and forward dependencies', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('EPIC-1/STORY-1/AC-1', 'EPIC-9/STORY-9/AC-9'), groups))
      .toThrow('preserve exactly its supplied PRD references')
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('src/preferences/store.ts', '../outside.ts'), groups))
      .toThrow('invalid target file path')
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('blockedByGroupIds: []', 'blockedByGroupIds: ["item:qa-v1-001"]'), groups))
      .toThrow('only on an earlier merge group')
    expect(() => parseManualQaFixBeadsOutput('<MANUAL_QA_FIX_BEADS>\nbeads: []\n</MANUAL_QA_FIX_BEADS>', groups))
      .toThrow()
  })
})
