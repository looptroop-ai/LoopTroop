import { describe, expect, it } from 'vitest'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'
import { getManualQaStoragePaths } from '../storage'
import {
  buildManualQaFixGroups,
  hydrateManualQaFixBeads,
  hasSuccessfulManualQaRepositoryToolCall,
  parseManualQaFixBeadsOutput,
  persistManualQaFixBeadCandidates,
  readManualQaFixBeadCandidates,
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
    testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]
    labels: ["preferences"]
    blockedByGroupIds: []
    targetFiles: ["src/preferences/store.ts", "src/preferences/store.test.ts"]
</MANUAL_QA_FIX_BEADS>`

describe('Manual QA fix-bead generation contracts', () => {
  it('reuses candidates only for the same retry guidance', () => {
    const ticketDir = makeTempDir('manual-qa-fix-note-')
    try {
      const groups = buildManualQaFixGroups(checklist, draft)
      const candidates = parseManualQaFixBeadsOutput(validResponse, groups)
      persistManualQaFixBeadCandidates(ticketDir, 1, candidates, 'Check the saved selection.')
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups, 'Check the saved selection.')).toEqual(candidates)
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups, 'Check reset behavior.')).toBeNull()
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups)).toBeNull()
      persistManualQaFixBeadCandidates(ticketDir, 1, candidates)
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups)).toEqual(candidates)
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups, 'Check reset behavior.')).toBeNull()
    } finally {
      removeTempDir(ticketDir)
    }
  })

  it('rejects a linked candidate document before reading or overwriting it', () => {
    const ticketDir = makeTempDir('manual-qa-fix-path-')
    const outside = makeTempDir('manual-qa-fix-outside-')
    try {
      const groups = buildManualQaFixGroups(checklist, draft)
      const candidates = parseManualQaFixBeadsOutput(validResponse, groups)
      const persisted = persistManualQaFixBeadCandidates(ticketDir, 1, candidates)
      expect(persisted).toContain('schemaVersion: 2')
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups)).toEqual(candidates)
      const path = getManualQaStoragePaths(ticketDir, 1).fixBeadsPath
      writeFileSync(path, readFileSync(path, 'utf8').replace('schemaVersion: 2', 'schemaVersion: 1'))
      expect(readManualQaFixBeadCandidates(ticketDir, 1, groups)).toBeNull()
      rmSync(path)
      symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => readManualQaFixBeadCandidates(ticketDir, 1, groups)).toThrow('escapes root')
      expect(() => persistManualQaFixBeadCandidates(ticketDir, 1, candidates)).toThrow('must not be a symbolic link')
    } finally {
      removeTempDir(ticketDir)
      removeTempDir(outside)
    }
  })

  const message = (
    status: 'running' | 'completed' | 'error',
    tool = 'read',
    input?: Record<string, unknown>,
  ): Message[] => [{
    id: 'message-one',
    role: 'assistant',
    parts: [{
      id: 'part-one',
      sessionID: 'session-one',
      messageID: 'message-one',
      type: 'tool',
      callID: 'call-one',
      tool,
      state: { status, ...(input ? { input } : {}) },
    }],
  }]

  it('accepts only a completed read-only tool call as inspection evidence', () => {
    const read = { path: 'src/store.ts' }
    expect(hasSuccessfulManualQaRepositoryToolCall(message('running', 'read', read))).toBe(false)
    expect(hasSuccessfulManualQaRepositoryToolCall(message('error', 'read', read))).toBe(false)
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', 'read', read))).toBe(true)
  })

  it.each([
    ['read', { path: 'src/store.ts' }],
    ['grep', { pattern: 'useStore' }],
    ['glob', { pattern: 'src/**/*.ts' }],
    ['list', { path: 'src' }],
    ['codesearch', { query: 'useStore' }],
    ['lsp', { filePath: 'src/store.ts' }],
  ] as [string, Record<string, unknown>][])('accepts %s', (tool, input) => {
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', tool, input))).toBe(true)
  })

  it.each(['todowrite', 'todoread', 'task', 'webfetch', 'bash', 'question'])('rejects %s', (tool) => {
    // A completed tool call of any kind used to satisfy the mandatory inspection.
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', tool))).toBe(false)
  })

  it.each([
    ['a parent-relative file', 'read', { path: '../config.json' }],
    ['an absolute file outside the worktree', 'read', { path: '/etc/hosts' }],
    ['an external directory pattern', 'glob', { pattern: '../shared/**/*.ts' }],
    ['a Windows absolute path', 'read', { filePath: 'C:\\Windows\\System32\\config' }],
  ] as [string, string, Record<string, unknown>][])('accepts safe inspection of %s', (_label, tool, input) => {
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', tool, input))).toBe(true)
  })

  it('does not accept a read that names no file', () => {
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', 'read'))).toBe(false)
    expect(hasSuccessfulManualQaRepositoryToolCall(message('completed', 'read', { limit: 20 }))).toBe(false)
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
        mode: 'process',
        program: 'npm',
        args: ['run', 'test:client'],
        cwd: '.',
        env: {},
      }],
      targetFiles: ['src/preferences/store.ts', 'src/preferences/store.test.ts'],
      dependencies: { blocked_by: [], blocks: [] },
      qaOrigin: { actionId: 'manual-qa-submit:one', sourceItems: [{ itemId: 'qa-v1-001' }] },
    })
    expect(bead?.id).toMatch(/^qa-v1-[a-f0-9]{12}$/)
  })

  it('rejects bare test command text instead of assigning a host shell', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const response = validResponse.replace(
      'testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]',
      'testCommands: ["npm run test:client"]',
    )

    expect(() => parseManualQaFixBeadsOutput(response, groups)).toThrow('testCommands')
  })

  it('drops a dependency on a merge group that does not exist', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const candidates = parseManualQaFixBeadsOutput(validResponse, groups).map((candidate) => ({
      ...candidate,
      blockedByGroupIds: ['hallucinated-group'],
    }))
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

    // `idByGroup.get(id)!` used to persist `blocked_by: [undefined]`.
    expect(bead?.dependencies.blocked_by).toEqual([])
  })

  it('accepts a zero-command fix bead with a reason and preserves it during hydration', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const response = validResponse.replace(
      '    testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]',
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
      validResponse.replace('    testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]', '    testCommands: []'),
      groups,
    )).toThrow('testCommandReason')
    expect(() => parseManualQaFixBeadsOutput(
      validResponse.replace(
        '    testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]',
        '    testCommands: [{mode: "process", program: "npm", args: ["run", "test:client"], cwd: ".", env: {}}]\n    testCommandReason: "Not allowed with commands."',
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

  it.each([
    [],
    ['/outside/settings.json'],
    ['C:/Users/User/settings.json'],
    ['../shared/settings.json'],
  ].map((targetFiles) => ({ targetFiles })))('accepts explicit repair-bead targets %j', ({ targetFiles }) => {
    const groups = buildManualQaFixGroups(checklist, draft)
    const response = validResponse.replace(
      '["src/preferences/store.ts", "src/preferences/store.test.ts"]',
      JSON.stringify(targetFiles),
    )
    expect(parseManualQaFixBeadsOutput(response, groups)[0]?.targetFiles).toEqual(targetFiles)
  })

  it('rejects missing groups, invented PRD refs, malformed targets, and forward dependencies', () => {
    const groups = buildManualQaFixGroups(checklist, draft)
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('EPIC-1/STORY-1/AC-1', 'EPIC-9/STORY-9/AC-9'), groups))
      .toThrow('preserve exactly its supplied PRD references')
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('    targetFiles: ["src/preferences/store.ts", "src/preferences/store.test.ts"]', '    targetFiles: null'), groups))
      .toThrow()
    expect(() => parseManualQaFixBeadsOutput(validResponse.replace('blockedByGroupIds: []', 'blockedByGroupIds: ["item:qa-v1-001"]'), groups))
      .toThrow('only on an earlier merge group')
    expect(() => parseManualQaFixBeadsOutput('<MANUAL_QA_FIX_BEADS>\nbeads: []\n</MANUAL_QA_FIX_BEADS>', groups))
      .toThrow()
  })
})
