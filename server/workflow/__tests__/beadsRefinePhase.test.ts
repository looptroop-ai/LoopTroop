import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as jsYaml from 'js-yaml'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { getLatestPhaseArtifact, getTicketByRef, insertPhaseArtifact } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { phaseIntermediate } from '../phases/state'

const { refineDraftMock, runOpenCodePromptMock } = vi.hoisted(() => ({
  refineDraftMock: vi.fn(),
  runOpenCodePromptMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../council/refiner', () => ({
  refineDraft: refineDraftMock,
}))

vi.mock('../runOpenCodePrompt', () => ({
  formatPromptText: (parts: Array<{ type?: string; source?: string; content?: string }>) => {
    if (parts.length === 1 && !parts[0]?.source) return parts[0]?.content ?? ''
    return parts.map((part) => `### ${part.source ?? part.type}\n${part.content ?? ''}`).join('\n\n')
  },
  runOpenCodePrompt: runOpenCodePromptMock,
}))

import { handleBeadsRefine } from '../phases/beadsPhase'
import { handleBeadsExpansion, handleCoverageVerification } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('beads-refine')

function buildPrdContent() {
  return [
    'schema_version: 1',
    'ticket_id: PROJ-1',
    'artifact: prd',
    'status: draft',
    'source_interview:',
    '  content_sha256: mock-sha',
    'product:',
    '  problem_statement: "Preserve refinement attribution."',
    '  target_users:',
    '    - "LoopTroop maintainers"',
    'scope:',
    '  in_scope:',
    '    - "Refinement diff attribution"',
    '  out_of_scope:',
    '    - "Workflow changes outside refinement"',
    'technical_requirements:',
    '  architecture_constraints:',
    '    - "Keep attribution deterministic"',
    '  data_model: []',
    '  api_contracts: []',
    '  security_constraints: []',
    '  performance_constraints: []',
    '  reliability_constraints: []',
    '  error_handling_rules: []',
    '  tooling_assumptions: []',
    'epics:',
    '  - id: "EPIC-1"',
    '    title: "Preserve refinement attribution"',
    '    objective: "Keep source lineage visible in spec diffs."',
    '    user_stories:',
    '      - id: "US-1"',
    '        title: "Validate refinement attribution"',
    '        acceptance_criteria:',
    '          - "Review validate refinement attribution."',
    '        implementation_steps:',
    '          - "Implement validate refinement attribution."',
    '        verification:',
    '          required_commands:',
    '            - "npm run test"',
    '      - id: "US-2"',
    '        title: "Review PRD drafts"',
    '        acceptance_criteria:',
    '          - "Review review prd drafts."',
    '        implementation_steps:',
    '          - "Implement review prd drafts."',
    '        verification:',
    '          required_commands:',
    '            - "npm run test"',
    'approval:',
    '  approved_by: ""',
    '  approved_at: ""',
  ].join('\n')
}

function buildBeadSubsetContent(options: {
  includeSecondBead?: boolean
  secondBeadId?: string
  secondBeadTitle?: string
  secondBeadDescription?: string
} = {}): string {
  const lines = [
    'beads:',
    '  - id: "bead-1"',
    '    title: "Validate refinement attribution"',
    '    prdRefs: ["EPIC-1 / US-1"]',
    '    description: "Preserve explicit inspiration in refinement diffs."',
    '    contextGuidance: |',
    '      Patterns:',
    '      - Keep repairs deterministic.',
    '      Anti-patterns:',
    '      - Do not widen the repair scope unnecessarily.',
    '    acceptanceCriteria:',
    '      - "Validate attribution survives refinement"',
    '    tests:',
    '      - "Shared tests cover refinement attribution"',
    '    testCommands:',
    '      - "npm run test:server"',
  ]

  if (options.includeSecondBead) {
    lines.push(
      `  - id: "${options.secondBeadId ?? 'bead-2'}"`,
      `    title: "${options.secondBeadTitle ?? 'Surface retry metadata'}"`,
      '    prdRefs: ["EPIC-1 / US-2"]',
      `    description: "${options.secondBeadDescription ?? 'Surface refinement retry metadata in the diff viewer.'}"`,
      '    contextGuidance: |',
      '      Patterns:',
      '      - Keep attribution deterministic.',
      '      Anti-patterns:',
      '      - Do not remove inspiration metadata.',
      '    acceptanceCriteria:',
      `      - "${options.secondBeadTitle ?? 'Surface retry metadata'} is covered in approval and review flows"`,
      '    tests:',
      '      - "UI tests show the correct inspiration tooltip"',
      '    testCommands:',
      '      - "npm run test:server"',
    )
  }

  return lines.join('\n')
}

function buildValidRefinementOutput(): string {
  return [
    'beads:',
    '  - id: "bead-1"',
    '    title: "Validate refinement attribution"',
    '    prdRefs: ["EPIC-1 / US-1"]',
    '    description: "Preserve explicit inspiration in refinement diffs."',
    '    contextGuidance: |',
    '      Patterns:',
    '      - Keep repairs deterministic.',
    '      Anti-patterns:',
    '      - Do not widen the repair scope unnecessarily.',
    '    acceptanceCriteria:',
    '      - "Validate attribution survives refinement"',
    '    tests:',
    '      - "Shared tests cover refinement attribution"',
    '    testCommands:',
    '      - "npm run test:server"',
    '  - id: "bead-2"',
    '    title: "Surface retry metadata"',
    '    prdRefs: ["EPIC-1 / US-2"]',
    '    description: "Surface refinement retry metadata in the diff viewer."',
    '    contextGuidance: |',
    '      Patterns:',
    '      - Keep attribution deterministic.',
    '      Anti-patterns:',
    '      - Do not remove inspiration metadata.',
    '    acceptanceCriteria:',
    '      - "Surface retry metadata is covered in approval and review flows"',
    '    tests:',
    '      - "UI tests show the correct inspiration tooltip"',
    '    testCommands:',
    '      - "npm run test:server"',
    'changes:',
    '  - type: added',
    '    item_type: bead',
    '    before: null',
    '    after:',
    '      id: "bead-2"',
    '      title: "Surface retry metadata"',
    '    inspiration:',
    '      alternative_draft: 1',
    '      item:',
    '        id: "bead-9"',
    '        title: "Adopt losing-draft telemetry"',
  ].join('\n')
}

function buildExpansionRecords(options: {
  secondBeadId?: string
  secondBeadTitle?: string
  secondBeadDescription?: string
} = {}) {
  return [
    {
      id: 'proj-1-validate-refinement-attribution',
      title: 'Validate refinement attribution',
      prdRefs: ['EPIC-1 / US-1'],
      description: 'Preserve explicit inspiration in refinement diffs.',
      contextGuidance: {
        patterns: ['Keep repairs deterministic.'],
        anti_patterns: ['Do not widen the repair scope unnecessarily.'],
      },
      acceptanceCriteria: ['Validate attribution survives refinement'],
      tests: ['Shared tests cover refinement attribution'],
      testCommands: ['npm run test:server'],
      issueType: 'task',
      labels: ['ticket:PROJ-1', 'story:US-1'],
      dependencies: { blocked_by: [] },
      targetFiles: ['server/workflow/phases/beadsPhase.ts'],
    },
    {
      id: options.secondBeadId ?? 'proj-1-render-coverage-warning-state',
      title: options.secondBeadTitle ?? 'Render coverage warning state',
      prdRefs: ['EPIC-1 / US-2'],
      description: options.secondBeadDescription ?? 'Surface unresolved coverage gaps during beads approval without blocking manual review.',
      contextGuidance: {
        patterns: ['Keep approval warnings collapsible and version-aware.'],
        anti_patterns: ['Do not hide unresolved gaps behind raw-only output.'],
      },
      acceptanceCriteria: [`${options.secondBeadTitle ?? 'Render coverage warning state'} shows unresolved coverage warning details.`],
      tests: ['Approval tests render the remaining coverage gaps warning.'],
      testCommands: ['npm test -- ApprovalView'],
      issueType: 'task',
      labels: ['ticket:PROJ-1', 'story:US-2'],
      dependencies: { blocked_by: ['proj-1-validate-refinement-attribution'] },
      targetFiles: ['src/components/workspace/ApprovalView.tsx'],
    },
  ]
}

function buildValidExpansionOutput(options?: {
  secondBeadId?: string
  secondBeadTitle?: string
  secondBeadDescription?: string
}): string {
  return buildExpansionRecords(options).map((bead) => JSON.stringify(bead)).join('\n')
}

function buildValidBeadsCoverageRevisionOutput(
  coverageGap: string,
  options: {
    secondBeadTitle?: string
    secondBeadDescription?: string
    affectedItemLabel?: string
    rationale?: string
  } = {},
): string {
  const secondBeadTitle = options.secondBeadTitle ?? 'Render coverage warning state'
  return jsYaml.dump({
    result: {
      beads: [
        {
          id: 'bead-1',
          title: 'Validate refinement attribution',
          prdRefs: ['EPIC-1 / US-1'],
          description: 'Preserve explicit inspiration in refinement diffs.',
          contextGuidance: {
            patterns: ['Keep repairs deterministic.'],
            anti_patterns: ['Do not widen the repair scope unnecessarily.'],
          },
          acceptanceCriteria: ['Validate attribution survives refinement'],
          tests: ['Shared tests cover refinement attribution'],
          testCommands: ['npm run test:server'],
        },
        {
          id: 'bead-2',
          title: secondBeadTitle,
          prdRefs: ['EPIC-1 / US-2'],
          description: options.secondBeadDescription ?? 'Surface unresolved coverage gaps during beads approval without blocking manual review.',
          contextGuidance: {
            patterns: ['Keep approval warnings collapsible and version-aware.'],
            anti_patterns: ['Do not hide unresolved gaps behind raw-only output.'],
          },
          acceptanceCriteria: ['Approval shows unresolved coverage warning details.'],
          tests: ['Approval tests render the remaining coverage gaps warning.'],
          testCommands: ['npm test -- ApprovalView'],
        },
      ],
      gap_resolutions: [
        {
          gap: coverageGap,
          action: 'updated_beads',
          rationale: options.rationale ?? 'Added a semantic bead that surfaces unresolved coverage gaps during approval.',
          affected_items: [
            {
              item_type: 'bead',
              id: 'bead-2',
              label: options.affectedItemLabel ?? secondBeadTitle,
            },
          ],
        },
      ],
    },
  }, { lineWidth: 120, noRefs: true }) as string
}

function readPersistedBeads(beadsPath: string) {
  return readFileSync(beadsPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as {
      id: string
      title: string
      priority: number
      status: string
      labels: string[]
      externalRef: string
      dependencies: { blocked_by: string[]; blocks: string[] }
    })
}

describe('handleBeadsRefine', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    refineDraftMock.mockReset()
    runOpenCodePromptMock.mockReset()
  })

  afterAll(() => {
    resetTestDb()
  })

  it('persists the semantic refined blueprint and refinement diff without expanding beads during REFINING_BEADS', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Preserve Beads refinement attribution',
      description: 'Keep explicit inspiration metadata in REFINING_BEADS diff artifacts.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const winnerDraftContent = buildBeadSubsetContent()
    const losingDraftContent = buildBeadSubsetContent({
      includeSecondBead: true,
      secondBeadId: 'bead-9',
      secondBeadTitle: 'Adopt losing-draft telemetry',
    })

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    phaseIntermediate.set(`${ticket.id}:beads`, {
      phase: 'beads',
      worktreePath: paths.worktreePath,
      winnerId,
      drafts: [
        { memberId: winnerId, outcome: 'completed', content: winnerDraftContent, duration: 1 },
        { memberId: TEST.councilMembers[1], outcome: 'completed', content: losingDraftContent, duration: 1 },
      ],
      memberOutcomes: {
        [winnerId]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      contextBuilder: () => [],
    })

    refineDraftMock.mockImplementationOnce(async (
      _adapter: unknown,
      _winnerDraft: unknown,
      _losingDrafts: unknown,
      _contextParts: unknown,
      _projectPath: unknown,
      _timeoutMs: unknown,
      _signal: unknown,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      _sessionOwnership: unknown,
      _buildPrompt: unknown,
      validateResponse?: (content: string) => { normalizedContent?: string },
    ) => ({
      content: validateResponse?.(buildValidRefinementOutput()).normalizedContent ?? buildValidRefinementOutput(),
      rawAttempts: [],
    }))

    await handleBeadsRefine(ticket.id, context, sendEvent, new AbortController().signal)

    const uiDiffArtifact = getLatestPhaseArtifact(ticket.id, 'ui_refinement_diff:beads', 'REFINING_BEADS')
    expect(uiDiffArtifact).toBeDefined()
    expect(JSON.parse(uiDiffArtifact!.content)).toMatchObject({
      domain: 'beads',
      winnerId,
      entries: expect.arrayContaining([
        expect.objectContaining({
          changeType: 'added',
          itemKind: 'bead',
          afterId: 'bead-2',
          inspiration: expect.objectContaining({
            memberId: TEST.councilMembers[1],
            sourceId: 'bead-9',
            sourceLabel: 'Adopt losing-draft telemetry',
          }),
          attributionStatus: 'inspired',
        }),
      ]),
    })

    const refinedArtifact = getLatestPhaseArtifact(ticket.id, 'beads_refined', 'REFINING_BEADS')
    expect(refinedArtifact).toBeDefined()
    expect(JSON.parse(refinedArtifact!.content)).toMatchObject({
      winnerId,
      refinedContent: expect.stringContaining('Surface retry metadata'),
    })

    expect(getLatestPhaseArtifact(ticket.id, 'beads_winner', 'REFINING_BEADS')).toBeDefined()
    expect(getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'REFINING_BEADS')).toBeUndefined()
    expect(existsSync(paths.beadsPath)).toBe(false)
    expect(runOpenCodePromptMock).not.toHaveBeenCalled()
    expect(phaseIntermediate.get(`${ticket.id}:beads`)).toBeUndefined()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'REFINED' })
  })

  it('runs terminal bead expansion only after beads coverage becomes clean', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Revise beads during coverage',
      description: 'Persist semantic coverage revisions, then expand once at the end.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const coverageGap = 'Missing a bead that surfaces unresolved coverage warnings during approval.'
    const initialBlueprint = buildBeadSubsetContent({ includeSecondBead: true })

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId,
        refinedContent: initialBlueprint,
      }),
    })

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-2', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-expand-session-4', projectPath: paths.worktreePath },
        response: buildValidExpansionOutput(),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'beads', new AbortController().signal)
    await handleBeadsExpansion(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(4)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })

    const coverageInput = getLatestPhaseArtifact(ticket.id, 'beads_coverage_input', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageInput).toBeDefined()
    expect(JSON.parse(coverageInput!.content)).toMatchObject({
      candidateVersion: 2,
      refinedContent: expect.stringContaining('Render coverage warning state'),
    })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'beads_coverage', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'clean',
      finalCandidateVersion: 2,
      hasRemainingGaps: false,
      remainingGaps: [],
    })

    const coverageCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_coverage', 'VERIFYING_BEADS_COVERAGE')
    const parsedCoverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanion!.content)?.payload as {
      attempts?: Array<{ candidateVersion?: number; status?: string; gaps?: string[] }>
      transitions?: Array<{ fromVersion?: number; toVersion?: number; gaps?: string[]; fromContent?: string; toContent?: string }>
      finalCandidateVersion?: number
      hasRemainingGaps?: boolean
      remainingGaps?: string[]
    } | undefined
    expect(parsedCoverageCompanion).toMatchObject({
      finalCandidateVersion: 2,
      hasRemainingGaps: false,
      remainingGaps: [],
      attempts: [
        expect.objectContaining({
          candidateVersion: 1,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 2,
          status: 'clean',
          gaps: [],
        }),
      ],
      transitions: [
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          gaps: [coverageGap],
          fromContent: expect.stringContaining('Surface retry metadata'),
          toContent: expect.stringContaining('Render coverage warning state'),
        }),
      ],
    })

    const coverageRevision = getLatestPhaseArtifact(ticket.id, 'beads_coverage_revision', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageRevision).toBeDefined()
    expect(JSON.parse(coverageRevision!.content)).toMatchObject({
      winnerId,
      candidateVersion: 2,
      refinedContent: expect.stringContaining('Render coverage warning state'),
    })

    const expandedArtifact = getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')
    expect(expandedArtifact).toBeDefined()
    expect(JSON.parse(expandedArtifact!.content)).toMatchObject({
      winnerId,
      candidateVersion: 2,
      expandedContent: expect.stringContaining('proj-1-render-coverage-warning-state'),
      refinedContent: expect.stringContaining('"status":"pending"'),
    })
    expect(getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'REFINING_BEADS')).toBeUndefined()

    const persistedBeads = readPersistedBeads(paths.beadsPath)
    expect(persistedBeads).toHaveLength(2)
    expect(persistedBeads[0]).toMatchObject({
      id: 'proj-1-validate-refinement-attribution',
      title: 'Validate refinement attribution',
      priority: 1,
      status: 'pending',
      externalRef: context.externalId,
      labels: ['ticket:PROJ-1', 'story:US-1'],
      dependencies: { blocked_by: [], blocks: ['proj-1-render-coverage-warning-state'] },
    })
    expect(persistedBeads[1]).toMatchObject({
      id: 'proj-1-render-coverage-warning-state',
      title: 'Render coverage warning state',
      priority: 2,
      status: 'pending',
      externalRef: context.externalId,
      labels: ['ticket:PROJ-1', 'story:US-2'],
      dependencies: { blocked_by: ['proj-1-validate-refinement-attribution'], blocks: [] },
    })

    const storedTicket = getTicketByRef(ticket.id)
    expect(storedTicket?.runtime.totalBeads).toBe(2)
    expect(storedTicket?.runtime.completedBeads).toBe(0)
    expect(storedTicket?.runtime.currentBead).toBe(1)
    expect(storedTicket?.runtime.percentComplete).toBe(0)
  })

  it('supports fourth beads coverage revision before a final clean v5 pass', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Revise beads to a final v5 candidate during coverage',
      description: 'Persist a second semantic coverage revision before the clean terminal expansion.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const coverageGap = 'Missing a final beads warning state that stays version-aware during approval.'
    const initialBlueprint = buildBeadSubsetContent({ includeSecondBead: true })

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId,
        refinedContent: initialBlueprint,
      }),
    })

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-2', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-4', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render final coverage warning state',
          secondBeadDescription: 'Surface final unresolved coverage gaps during beads approval without blocking manual review.',
          affectedItemLabel: 'Render final coverage warning state',
          rationale: 'Updated the semantic bead so the final approval warning stays version-aware.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-5', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-6', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render rollback-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings rollback-safe and version-aware during approval.',
          affectedItemLabel: 'Render rollback-safe coverage warning state',
          rationale: 'Updated the semantic bead so rollback recovery stays aligned with coverage revisions.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-7', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-8', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render final review-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings review-safe and version-aware during approval.',
          affectedItemLabel: 'Render final review-safe coverage warning state',
          rationale: 'Updated the semantic bead so the final approval warning stays review-safe on the last configured pass.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-9', projectPath: paths.worktreePath },
        response: [
          'status: clean',
          'gaps: []',
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-expand-session-10', projectPath: paths.worktreePath },
        response: buildValidExpansionOutput({
          secondBeadId: 'proj-1-render-final-review-safe-coverage-warning-state',
          secondBeadTitle: 'Render final review-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings review-safe and version-aware during approval.',
        }),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'beads', new AbortController().signal)
    await handleBeadsExpansion(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(10)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'beads_coverage', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'clean',
      coverageRunNumber: 5,
      maxCoveragePasses: 5,
      finalCandidateVersion: 5,
      hasRemainingGaps: false,
      remainingGaps: [],
      terminationReason: 'clean',
    })

    const coverageCompanion = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_coverage', 'VERIFYING_BEADS_COVERAGE')
    const parsedCoverageCompanion = parseUiArtifactCompanionArtifact(coverageCompanion!.content)?.payload as {
      attempts?: Array<{ candidateVersion?: number; status?: string; gaps?: string[] }>
      transitions?: Array<{ fromVersion?: number; toVersion?: number; gaps?: string[] }>
      finalCandidateVersion?: number
      hasRemainingGaps?: boolean
      remainingGaps?: string[]
    } | undefined
    expect(parsedCoverageCompanion).toMatchObject({
      finalCandidateVersion: 5,
      hasRemainingGaps: false,
      remainingGaps: [],
      attempts: [
        expect.objectContaining({
          candidateVersion: 1,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 2,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 3,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 4,
          status: 'gaps',
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          candidateVersion: 5,
          status: 'clean',
          gaps: [],
        }),
      ],
      transitions: [
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 2,
          toVersion: 3,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 3,
          toVersion: 4,
          gaps: [coverageGap],
        }),
        expect.objectContaining({
          fromVersion: 4,
          toVersion: 5,
          gaps: [coverageGap],
        }),
      ],
    })

    const coverageRevision = getLatestPhaseArtifact(ticket.id, 'beads_coverage_revision', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageRevision).toBeDefined()
    expect(JSON.parse(coverageRevision!.content)).toMatchObject({
      winnerId,
      candidateVersion: 5,
      refinedContent: expect.stringContaining('Render final review-safe coverage warning state'),
    })

    const expandedArtifact = getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')
    expect(expandedArtifact).toBeDefined()
    expect(JSON.parse(expandedArtifact!.content)).toMatchObject({
      winnerId,
      candidateVersion: 5,
      expandedContent: expect.stringContaining('proj-1-render-final-review-safe-coverage-warning-state'),
      refinedContent: expect.stringContaining('"status":"pending"'),
    })

    const persistedBeads = readPersistedBeads(paths.beadsPath)
    expect(persistedBeads).toHaveLength(2)
    expect(persistedBeads[1]).toMatchObject({
      id: 'proj-1-render-final-review-safe-coverage-warning-state',
      title: 'Render final review-safe coverage warning state',
      status: 'pending',
    })

    const storedTicket = getTicketByRef(ticket.id)
    expect(storedTicket?.runtime.totalBeads).toBe(2)
    expect(storedTicket?.runtime.currentBead).toBe(1)
    expect(storedTicket?.runtime.percentComplete).toBe(0)
  })

  it('still runs the terminal bead expansion before approval when beads coverage reaches v5 with unresolved gaps', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Expand final beads even when coverage caps out',
      description: 'Coverage warnings should survive into approval, but the final expanded beads must still exist.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const coverageGap = 'Missing a bead that surfaces unresolved coverage warnings during approval.'
    const initialBlueprint = buildBeadSubsetContent({ includeSecondBead: true })

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId,
        refinedContent: initialBlueprint,
      }),
    })

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-1', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-2', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-3', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-4', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render final coverage warning state',
          secondBeadDescription: 'Surface final unresolved coverage gaps during beads approval without blocking manual review.',
          affectedItemLabel: 'Render final coverage warning state',
          rationale: 'Updated the semantic bead so the final approval warning stays version-aware.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-5', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-6', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render rollback-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings rollback-safe and version-aware during approval.',
          affectedItemLabel: 'Render rollback-safe coverage warning state',
          rationale: 'Updated the semantic bead so rollback recovery stays aligned with coverage revisions.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-7', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-8', projectPath: paths.worktreePath },
        response: buildValidBeadsCoverageRevisionOutput(coverageGap, {
          secondBeadTitle: 'Render final review-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings review-safe and version-aware during approval.',
          affectedItemLabel: 'Render final review-safe coverage warning state',
          rationale: 'Updated the semantic bead so the final approval warning stays review-safe on the last configured pass.',
        }),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-coverage-session-9', projectPath: paths.worktreePath },
        response: [
          'status: gaps',
          'gaps:',
          `  - "${coverageGap}"`,
          'follow_up_questions: []',
        ].join('\n'),
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'beads-expand-after-limit', projectPath: paths.worktreePath },
        response: buildValidExpansionOutput({
          secondBeadId: 'proj-1-render-final-review-safe-coverage-warning-state',
          secondBeadTitle: 'Render final review-safe coverage warning state',
          secondBeadDescription: 'Keep unresolved coverage warnings review-safe and version-aware during approval.',
        }),
        messages: [],
      })

    await handleCoverageVerification(ticket.id, context, sendEvent, 'beads', new AbortController().signal)
    await handleBeadsExpansion(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(10)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_LIMIT_REACHED' })

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'beads_coverage', 'VERIFYING_BEADS_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(JSON.parse(coverageArtifact!.content)).toMatchObject({
      status: 'gaps',
      coverageRunNumber: 5,
      maxCoveragePasses: 5,
      finalCandidateVersion: 5,
      limitReached: true,
      hasRemainingGaps: true,
      remainingGaps: [coverageGap],
      terminationReason: 'coverage_pass_limit_reached',
    })

    const expandedArtifact = getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')
    expect(expandedArtifact).toBeDefined()
    expect(JSON.parse(expandedArtifact!.content)).toMatchObject({
      winnerId,
      candidateVersion: 5,
      expandedContent: expect.stringContaining('proj-1-render-final-review-safe-coverage-warning-state'),
      refinedContent: expect.stringContaining('"status":"pending"'),
    })

    const persistedBeads = readPersistedBeads(paths.beadsPath)
    expect(persistedBeads).toHaveLength(2)
    expect(persistedBeads[1]).toMatchObject({
      id: 'proj-1-render-final-review-safe-coverage-warning-state',
      title: 'Render final review-safe coverage warning state',
      status: 'pending',
    })

    const storedTicket = getTicketByRef(ticket.id)
    expect(storedTicket?.runtime.totalBeads).toBe(2)
    expect(storedTicket?.runtime.currentBead).toBe(1)
    expect(storedTicket?.runtime.percentComplete).toBe(0)
  })
})

describe('handleBeadsExpansion', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    runOpenCodePromptMock.mockReset()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('emits EXPANDED and persists beads_expanded under EXPANDING_BEADS on success', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Expand beads blueprint into execution-ready records',
      description: 'Run expansion after coverage is clean.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]
    const initialBlueprint = buildBeadSubsetContent({
      includeSecondBead: true,
      secondBeadTitle: 'Render coverage warning state',
      secondBeadDescription: 'Surface unresolved coverage gaps during beads approval without blocking manual review.',
    })

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({ winnerId, refinedContent: initialBlueprint }),
    })

    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'beads-expand-session-1', projectPath: paths.worktreePath },
      response: buildValidExpansionOutput(),
      messages: [],
    })

    await handleBeadsExpansion(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXPANDED' })

    const expandedArtifact = getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')
    expect(expandedArtifact).toBeDefined()
    expect(JSON.parse(expandedArtifact!.content)).toMatchObject({
      winnerId,
      candidateVersion: 1,
      expandedContent: expect.stringContaining('proj-1-validate-refinement-attribution'),
    })

    const persistedBeads = readPersistedBeads(paths.beadsPath)
    expect(persistedBeads).toHaveLength(2)
    expect(persistedBeads[0]).toMatchObject({
      id: 'proj-1-validate-refinement-attribution',
      status: 'pending',
    })
  })

  it('emits ERROR when no expansion input (no beads_refined artifact) is found', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Expansion fails without blueprint',
      description: 'Expansion should error when no coverage revision or refined artifact exists.',
    })
    const sendEvent = vi.fn()
    const winnerId = TEST.councilMembers[0]

    writeFileSync(resolve(paths.ticketDir, 'prd.yaml'), buildPrdContent(), 'utf-8')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId }),
    })
    // Intentionally omit beads_refined / beads_coverage_revision — no blueprint available.

    await handleBeadsExpansion(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ERROR', codes: ['COVERAGE_FAILED'] }),
    )
    expect(getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')).toBeUndefined()
  })
})
