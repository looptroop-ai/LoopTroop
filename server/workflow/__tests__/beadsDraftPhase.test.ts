import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { getLatestPhaseArtifact } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { phaseIntermediate } from '../phases/state'

const { draftBeadsMock } = vi.hoisted(() => ({
  draftBeadsMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../phases/beads/draft', async () => {
  const actual = await vi.importActual<typeof import('../../phases/beads/draft')>('../../phases/beads/draft')
  return {
    ...actual,
    draftBeads: draftBeadsMock,
  }
})

import { handleBeadsDraft } from '../phases/beadsPhase'

const repoManager = createTestRepoManager('beads-draft')

describe('handleBeadsDraft', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    draftBeadsMock.mockReset()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('loads PRD and relevant-files context, then persists structured draft metrics in the companion artifact', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Harden DRAFTING_BEADS',
      description: 'Keep beads draft context and companion artifacts strict.',
    })

    writeFileSync(
      `${paths.ticketDir}/relevant-files.yaml`,
      [
        'file_count: 1',
        'files:',
        '  - path: server/phases/beads/draft.ts',
        '    rationale: The drafting prompt needs the beads phase source.',
        '    relevance: high',
        '    likely_action: read',
        '    content_preview: |',
        '      export function draftBeads(...)',
      ].join('\n'),
      'utf-8',
    )
    writeFileSync(
      `${paths.ticketDir}/prd.yaml`,
      [
        'schema_version: 1',
        `ticket_id: "${ticket.externalId}"`,
        'artifact: "prd"',
        'status: "approved"',
        'source_interview:',
        '  content_sha256: "prd-sha"',
        'product:',
        '  problem_statement: "Harden beads drafting"',
        '  target_users:',
        '    - "LoopTroop maintainers"',
        'scope:',
        '  in_scope:',
        '    - "Generate a strong beads breakdown"',
        '  out_of_scope:',
        '    - "Execution"',
        'technical_requirements:',
        '  architecture_constraints:',
        '    - "Keep context loading deterministic"',
        '  data_model: []',
        '  api_contracts: []',
        '  security_constraints: []',
        '  performance_constraints: []',
        '  reliability_constraints: []',
        '  error_handling_rules: []',
        '  tooling_assumptions: []',
        'epics:',
        '  - id: "EPIC-1"',
        '    title: "Beads"',
        '    objective: "Break the PRD into beads."',
        '    implementation_steps:',
        '      - "Draft beads"',
        '    user_stories:',
        '      - id: "US-1-1"',
        '        title: "Split work into beads"',
        '        acceptance_criteria:',
        '          - "Each bead has tests"',
        '        implementation_steps:',
        '          - "Write beads"',
        '        verification:',
        '          required_commands:',
        '            - "npm run test:server"',
        'risks:',
        '  - "Bead context may drift"',
        'approval:',
        '  approved_by: "user"',
        '  approved_at: "2026-03-29T10:00:00.000Z"',
      ].join('\n'),
      'utf-8',
    )
    const sendEvent = vi.fn()
    const receivedContexts: string[] = []

    draftBeadsMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: unknown,
      ticketContext: Array<{ source?: string; content?: string }>,
      _worktreePath: unknown,
      _options: unknown,
      _signal: unknown,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onDraftProgress?: (entry: {
        memberId: string
        status: string
        sessionId?: string
        outcome?: string
        duration?: number
        content?: string
        questionCount?: number
        draftMetrics?: {
          beadCount?: number
          totalTestCount?: number
          totalAcceptanceCriteriaCount?: number
        }
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            target?: string
            excerpt?: string
          }>
        }
      }) => void,
    ) => {
      receivedContexts.push(ticketContext.map((part) => `${part.source ?? 'text'}:${part.content ?? ''}`).join('\n'))
      const repairedDraftContent = [
        'beads:',
        '  - id: bead-1',
        '    title: Harden beads drafting',
        '    prdRefs: [EPIC-1, US-1-1]',
        '    description: Keep beads drafting strict and deterministic.',
        '    contextGuidance: "Patterns: load codebase map, ticket details, and final PRD. Anti-patterns: do not omit later beads when the output gets long."',
        '    acceptanceCriteria:',
        '      - Draft is complete.',
        '    tests:',
        '      - Server test covers PROM20 output.',
        '    testCommands:',
        '      - npm run test:server',
      ].join('\n')
      const cleanDraftContent = [
        'beads:',
        '  - id: bead-1',
        '    title: Harden beads drafting',
        '    prdRefs: [EPIC-1, US-1-1]',
        '    description: Keep beads drafting strict and deterministic.',
        '    contextGuidance:',
        '      Patterns:',
        '        - Load codebase map, ticket details, and final PRD.',
        '      Anti-patterns:',
        '        - Do not omit later beads when the output gets long.',
        '    acceptanceCriteria:',
        '      - Draft is complete.',
        '    tests:',
        '      - Server test covers PROM20 output.',
        '    testCommands:',
        '      - npm run test:server',
      ].join('\n')
      onDraftProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'session_created',
        sessionId: 'session-beads-a',
      })
      onDraftProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'finished',
        sessionId: 'session-beads-a',
        outcome: 'completed',
        duration: 42,
        content: repairedDraftContent,
        draftMetrics: {
          beadCount: 3,
          totalTestCount: 6,
          totalAcceptanceCriteriaCount: 9,
        },
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Canonicalized inline string context guidance at index 0 into Patterns and Anti-patterns sections.'],
          autoRetryCount: 1,
          validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
          retryDiagnostics: [
            {
              attempt: 1,
              validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
              target: 'index 0',
              excerpt: '1 | beads:',
            },
          ],
        },
      })
      onDraftProgress?.({
        memberId: TEST.councilMembers[1],
        status: 'finished',
        outcome: 'completed',
        duration: 31,
        content: cleanDraftContent,
        draftMetrics: {
          beadCount: 3,
          totalTestCount: 5,
          totalAcceptanceCriteriaCount: 7,
        },
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 0,
        },
      })
      return {
        phase: 'beads_draft',
        drafts: [
          {
            memberId: TEST.councilMembers[0],
            outcome: 'completed',
            duration: 42,
            draftMetrics: {
              beadCount: 3,
              totalTestCount: 6,
              totalAcceptanceCriteriaCount: 9,
            },
            content: repairedDraftContent,
            structuredOutput: {
              repairApplied: true,
              repairWarnings: ['Canonicalized inline string context guidance at index 0 into Patterns and Anti-patterns sections.'],
              autoRetryCount: 1,
              validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
              retryDiagnostics: [
                {
                  attempt: 1,
                  validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
                  target: 'index 0',
                  excerpt: '1 | beads:',
                },
              ],
            },
          },
          {
            memberId: TEST.councilMembers[1],
            outcome: 'completed',
            duration: 31,
            draftMetrics: {
              beadCount: 3,
              totalTestCount: 5,
              totalAcceptanceCriteriaCount: 7,
            },
            content: cleanDraftContent,
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 0,
            },
          },
        ],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
      }
    })

    await handleBeadsDraft(ticket.id, context, sendEvent, new AbortController().signal)

    expect(receivedContexts).toHaveLength(1)
    expect(receivedContexts[0]).toContain('prd:') // PRD content loaded from disk
    expect(receivedContexts[0]).toContain('Harden beads drafting')
    expect(receivedContexts[0]).toContain('relevant_files:')
    expect(receivedContexts[0]).toContain('server/phases/beads/draft.ts')

    const draftsArtifact = getLatestPhaseArtifact(ticket.id, 'beads_drafts', 'DRAFTING_BEADS')
    expect(draftsArtifact).toBeDefined()
    const draftsArtifactContent = JSON.parse(draftsArtifact!.content) as {
      drafts?: Array<{ memberId?: string; outcome?: string; content?: string }>
      memberOutcomes?: Record<string, string>
      isFinal?: boolean
    }
    expect(draftsArtifactContent.isFinal).toBe(true)
    expect(draftsArtifactContent.memberOutcomes).toEqual({
      [TEST.councilMembers[0]]: 'completed',
      [TEST.councilMembers[1]]: 'completed',
    })

    const companionArtifact = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_drafts', 'DRAFTING_BEADS')
    expect(companionArtifact).toBeDefined()
    const companionPayload = parseUiArtifactCompanionArtifact(companionArtifact!.content)?.payload as {
      draftDetails?: Array<{
        memberId?: string
        duration?: number
        draftMetrics?: {
          beadCount?: number
          totalTestCount?: number
          totalAcceptanceCriteriaCount?: number
        }
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            target?: string
            excerpt?: string
          }>
        }
      }>
    } | undefined
    expect(companionPayload?.draftDetails).toHaveLength(2)
    expect(companionPayload?.draftDetails?.[0]?.duration).toBe(42)
    expect(companionPayload?.draftDetails?.[0]?.draftMetrics).toEqual({
      beadCount: 3,
      totalTestCount: 6,
      totalAcceptanceCriteriaCount: 9,
    })
    expect(companionPayload?.draftDetails?.[0]?.structuredOutput).toMatchObject({
      repairApplied: true,
      autoRetryCount: 1,
      validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
    })
    expect(companionPayload?.draftDetails?.[0]?.structuredOutput?.repairWarnings).toContain('Canonicalized inline string context guidance at index 0 into Patterns and Anti-patterns sections.')
    expect(companionPayload?.draftDetails?.[0]?.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Bead context guidance at index 0 must include both Patterns and Anti-patterns sections',
        target: 'index 0',
        excerpt: '1 | beads:',
      }),
    ])
    expect(existsSync(paths.executionLogPath)).toBe(true)
    const executionLog = readFileSync(paths.executionLogPath, 'utf-8')
    expect(executionLog).toContain('Beads draft round completed')
    expect(executionLog).toContain('Beads draft normalization applied repairs')
    expect(executionLog).toContain('Beads draft required 1 structured retry attempt(s)')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'DRAFTS_READY' })
    expect(phaseIntermediate.get(`${ticket.id}:beads`)).toBeDefined()
    expect(paths.ticketDir).toContain('.ticket')
  })
})
