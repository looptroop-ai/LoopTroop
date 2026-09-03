import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { readTicketMeta } from '../../ticket/metadata'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { attachProject, updateProject } from '../projects'
import {
  createTicket,
  createManualQaImprovementTicket,
  DISPLAY_ONLY_MOCK_BRANCH_NAME,
  findProjectExecutionBandConflict,
  getTicketByRef,
  getTicketPaths,
  insertPhaseArtifact,
  listNonTerminalTickets,
  lockTicketStartConfiguration,
  patchTicket,
  recordTicketErrorOccurrence,
  resolveLatestTicketErrorOccurrence,
  updateTicket,
} from '../tickets'
import { getTicketAiLogPath, getTicketDebugLogPath, normalizeFolderPath } from '../paths'
import {
  buildManualQaProjection,
  persistManualQaChecklist,
  persistManualQaSummary,
  reserveManualQaVersion,
} from '../../phases/manualQa'

const lockRepoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-lock-',
  files: {
    'README.md': '# LoopTroop Ticket Lock Test\n',
  },
})

const errorRepoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-error-',
  files: {
    'README.md': '# LoopTroop Ticket Error Test\n',
  },
})

const mockRepoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-mock-',
  files: {
    'README.md': '# LoopTroop Mock Ticket Test\n',
  },
})

describe('ticket start configuration locking', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    lockRepoManager.cleanup()
  })

  it('does not advance the ticket counter when the insert fails', async () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
    const { getProjectContextById } = await import('../projects')
    const { projects, tickets } = await import('../../db/schema')
    const { eq } = await import('drizzle-orm')

    const first = createTicket({ projectId: project.id, title: 'First' })
    expect(first.externalId).toBe('LOOP-1')

    // The next id is already taken, so the insert fails after the counter has
    // been advanced. Apart, the two statements burn a number every time.
    const context = getProjectContextById(project.id)!
    context.projectDb.update(tickets)
      .set({ externalId: 'LOOP-2' })
      .where(eq(tickets.externalId, first.externalId))
      .run()

    expect(() => createTicket({ projectId: project.id, title: 'Collides' })).toThrow()

    const counterAfter = context.projectDb.select().from(projects).where(eq(projects.id, project.id)).get()?.ticketCounter
    expect(counterAfter).toBe(1)
  })

  it('persists the started model selection into ticket metadata and blocks later model changes', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Freeze ticket council',
      description: 'Ticket models should lock when work starts.',
    })

    const startedAt = '2026-03-13T12:00:00.000Z'
    const lockedMainImplementer = 'openai/gpt-5-codex'
    const lockedCouncilMembers = ['openai/gpt-5-codex', 'openai/gpt-5-mini']

    const lockedTicket = lockTicketStartConfiguration(ticket.id, {
      branchName: ticket.externalId,
      startedAt,
      lockedMainImplementer,
      lockedCouncilMembers,
      lockedInterviewQuestions: 50,
      lockedCoverageFollowUpBudgetPercent: 20,
      lockedMaxCoveragePasses: 2,
      lockedMaxPrdCoveragePasses: 5,
      lockedMaxBeadsCoveragePasses: 5,
      lockedStructuredRetryCount: 3,
    })

    expect(lockedTicket?.lockedMainImplementer).toBe(lockedMainImplementer)
    expect(lockedTicket?.lockedCouncilMembers).toEqual(lockedCouncilMembers)
    expect(lockedTicket?.lockedCoverageFollowUpBudgetPercent).toBe(20)
    expect(lockedTicket?.lockedMaxCoveragePasses).toBe(2)
    expect(lockedTicket?.lockedMaxPrdCoveragePasses).toBe(5)
    expect(lockedTicket?.lockedMaxBeadsCoveragePasses).toBe(5)
    expect(lockedTicket?.lockedStructuredRetryCount).toBe(3)
    expect(lockedTicket?.lockedManualQaEnabled).toBe(false)
    expect(lockedTicket?.lockedManualQaSource).toBe('profile')
    expect(lockedTicket?.lockedGitHookPolicy).toBe('validate_advisory')
    expect(lockedTicket?.lockedGitHookPolicySource).toBe('profile')
    expect(lockedTicket?.startedAt).toBe(startedAt)

    const meta = readTicketMeta(repoDir, ticket.externalId)
    expect(meta.startedAt).toBe(startedAt)
    expect(meta.lockedMainImplementer).toBe(lockedMainImplementer)
    expect(meta.lockedCouncilMembers).toEqual(lockedCouncilMembers)

    const repeatedLock = lockTicketStartConfiguration(ticket.id, {
      branchName: ticket.externalId,
      startedAt: '2026-03-13T13:00:00.000Z',
      lockedMainImplementer,
      lockedCouncilMembers,
      lockedInterviewQuestions: 50,
      lockedCoverageFollowUpBudgetPercent: 20,
      lockedMaxCoveragePasses: 2,
      lockedMaxPrdCoveragePasses: 5,
      lockedMaxBeadsCoveragePasses: 5,
      lockedStructuredRetryCount: 3,
    })

    expect(repeatedLock?.startedAt).toBe(startedAt)
    expect(readTicketMeta(repoDir, ticket.externalId).startedAt).toBe(startedAt)

    expect(() => lockTicketStartConfiguration(ticket.id, {
      branchName: ticket.externalId,
      startedAt,
      lockedMainImplementer,
      lockedCouncilMembers,
      lockedInterviewQuestions: 50,
      lockedCoverageFollowUpBudgetPercent: 20,
      lockedMaxCoveragePasses: 2,
      lockedMaxPrdCoveragePasses: 5,
      lockedMaxBeadsCoveragePasses: 5,
      lockedStructuredRetryCount: 3,
      lockedManualQaEnabled: true,
      lockedManualQaSource: 'ticket',
    })).toThrow(/Manual QA configuration is immutable after start/i)

    expect(() => patchTicket(ticket.id, {
      lockedMainImplementer: 'anthropic/claude-sonnet-4',
    })).toThrow(/immutable after start/i)

    expect(() => patchTicket(ticket.id, {
      lockedCouncilMembers: JSON.stringify(['openai/gpt-5-codex', 'anthropic/claude-sonnet-4']),
    })).toThrow(/immutable after start/i)

    // Reordering the same members is the case a set comparison let through.
    // `members[0]` is the main implementer, so a permutation changes who
    // implements the ticket and has to fail the lock like any other change.
    expect(() => patchTicket(ticket.id, {
      lockedCouncilMembers: JSON.stringify([...lockedCouncilMembers].reverse()),
    })).toThrow(/immutable after start/i)

    // The same roster in the same order is not a change.
    expect(() => patchTicket(ticket.id, {
      lockedCouncilMembers: JSON.stringify(lockedCouncilMembers),
    })).not.toThrow()

    expect(() => patchTicket(ticket.id, {
      lockedManualQaEnabled: true,
    })).toThrow(/Manual QA configuration is immutable after start/i)

    expect(() => patchTicket(ticket.id, {
      lockedGitHookPolicy: 'observe_only',
    })).toThrow(/Git hook configuration is immutable after start/i)

    const progressUpdate = patchTicket(ticket.id, {
      percentComplete: 25,
    })

    expect(progressUpdate?.percentComplete).toBe(25)
    expect(getTicketByRef(ticket.id)?.lockedCouncilMembers).toEqual(lockedCouncilMembers)
    // getTicketPaths derives from the stored project root, which was normalized
    // on attach; repoDir is the raw fixture path and differs on Windows.
    const normalizedRepoDir = normalizeFolderPath(repoDir)
    expect(getTicketPaths(ticket.id)?.debugLogPath).toBe(getTicketDebugLogPath(normalizedRepoDir, ticket.externalId))
    expect(getTicketPaths(ticket.id)?.aiLogPath).toBe(getTicketAiLogPath(normalizedRepoDir, ticket.externalId))
  })

  it('keeps Git hook policy project-owned for Draft tickets', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop Hook Settings',
      shortname: 'HOOK',
      gitHookPolicy: 'observe_only',
    })
    const ticket = createTicket({ projectId: project.id, title: 'Project hook policy' })

    expect(ticket).toMatchObject({
      effectiveGitHookPolicy: 'observe_only',
      effectiveGitHookPolicySource: 'project',
    })
    expect(ticket).not.toHaveProperty('gitHookPolicy')
    updateProject(project.id, { gitHookPolicy: 'use_native_hooks' })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      effectiveGitHookPolicy: 'use_native_hooks',
      effectiveGitHookPolicySource: 'project',
    })
  })

  it('recovers the same improvement ticket after database creation but before origin files exist', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'Manual QA recovery', shortname: 'MQR' })
    const first = createManualQaImprovementTicket({
      projectId: project.id,
      originId: 'manual-qa:MQR-1:v1:improvement-one',
      actionId: 'submit-one',
      title: 'Follow-up improvement',
      description: 'Keep the selected filter.',
      priority: 2,
      manualQaEnabled: true,
    })
    // This return point represents the crash window before operations.ts writes
    // `.ticket/meta/manual-qa-origin.json` and copies evidence.
    rmSync(getTicketPaths(first.id)!.ticketDir, { recursive: true, force: true })
    const restored = createManualQaImprovementTicket({
      projectId: project.id,
      originId: 'manual-qa:MQR-1:v1:improvement-one',
      actionId: 'submit-one',
      title: 'Follow-up improvement',
      description: 'Keep the selected filter.',
      priority: 2,
      manualQaEnabled: true,
    })
    expect(restored.id).toBe(first.id)
    expect(restored.externalId).toBe(first.externalId)
    expect(restored.priority).toBe(2)
    expect(restored.manualQaOverride).toBe(true)
    expect(readTicketMeta(repoDir, restored.externalId).externalId).toBe(restored.externalId)
  })

  it('projects loop-aware visited statuses with a monotonic workflow revision', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'VIS' })
    const ticket = createTicket({ projectId: project.id, title: 'Visit Manual QA twice' })

    patchTicket(ticket.id, { status: 'RUNNING_FINAL_TEST' })
    patchTicket(ticket.id, { status: 'GENERATING_QA_CHECKLIST' })
    patchTicket(ticket.id, { status: 'WAITING_MANUAL_QA' })
    const waiting = getTicketByRef(ticket.id)
    patchTicket(ticket.id, { status: 'CODING' })
    const looped = getTicketByRef(ticket.id)

    expect(waiting?.workflowRevision).toBe(3)
    expect(looped?.workflowRevision).toBe(4)
    expect(looped?.visitedStatuses).toEqual([
      'DRAFT',
      'RUNNING_FINAL_TEST',
      'GENERATING_QA_CHECKLIST',
      'WAITING_MANUAL_QA',
      'CODING',
    ])
  })

  it('decodes append-only Manual QA artifact envelopes in public and runtime projections', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'QAP' })
    const ticket = createTicket({ projectId: project.id, title: 'Project Manual QA outcome' })
    insertPhaseArtifact(ticket.id, {
      phase: 'RUNNING_FINAL_TEST',
      artifactType: 'final_test_report',
      content: JSON.stringify({ status: 'passed', passed: true }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_MANUAL_QA',
      artifactType: 'manual_qa_summary',
      content: JSON.stringify({
        idempotencyKey: '2:created_fixes',
        value: { version: 2, outcome: 'created_fixes' },
      }),
    })

    const projected = getTicketByRef(ticket.id)
    expect(projected?.manualQa).toMatchObject({
      activeVersion: null,
      completedRoundCount: 1,
      latestOutcome: 'created_fixes',
    })
    expect(projected?.runtime.finalTestStatus).toBe('pending')

    insertPhaseArtifact(ticket.id, {
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: 'manual_qa_generation_reservation',
      content: JSON.stringify({ version: 3, state: 'reserved' }),
    })
    expect(getTicketByRef(ticket.id)?.manualQa).toMatchObject({
      activeVersion: 3,
      artifactAvailability: { checklist: false, results: false, coverage: false, summary: false },
    })

    insertPhaseArtifact(ticket.id, {
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: 'manual_qa_checklist',
      content: JSON.stringify({ version: 3, artifact: 'manual_qa_checklist' }),
    })
    expect(getTicketByRef(ticket.id)?.manualQa).toMatchObject({
      activeVersion: 3,
      artifactAvailability: { checklist: true, results: false, coverage: false, summary: false },
    })
  })

  it('indexes Manual QA rounds with artifact availability and phase-attempt identity', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'Manual QA versions', shortname: 'MQV' })
    const ticket = createTicket({ projectId: project.id, title: 'Read prior Manual QA while generating' })
    const ticketDir = getTicketPaths(ticket.id)!.ticketDir
    persistManualQaChecklist(ticketDir, {
      schemaVersion: 1,
      artifact: 'manual_qa_checklist',
      ticketId: ticket.externalId,
      version: 1,
      generatedAt: '2026-07-13T00:00:00.000Z',
      summary: 'Verify the first round.',
      notApplicablePrdRefs: [],
      items: [{
        id: 'qa-v1-001',
        lineageId: 'first-round',
        priorItemIds: [],
        title: 'Verify behavior',
        source: 'prd',
        behavior: 'The behavior remains visible.',
        severity: 'required',
        recheckState: 'new',
        prerequisites: [],
        actions: ['Exercise the behavior.'],
        expectedResult: 'The behavior is visible.',
        watchNotes: [],
        beadRefs: [],
        prdRefs: [],
      }],
    })
    persistManualQaSummary(ticketDir, {
      schemaVersion: 1,
      artifact: 'manual_qa_summary',
      ticketId: ticket.externalId,
      version: 1,
      outcome: 'passed',
      createdFixBeadIds: [],
      improvementTicketIds: [],
      waivedItemIds: [],
      waivedItems: [],
      startedAt: '2026-07-13T00:00:00.000Z',
      completedAt: '2026-07-13T00:01:00.000Z',
      durationMs: 60_000,
      itemCounts: { pass: 1, fail: 0, waive: 0, improvement: 0, pending: 0 },
      requiredItemCount: 1,
      optionalItemCount: 0,
      evidenceCount: 0,
      nextAction: 'integrate',
      coverage: { covered: 0, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
      modelCapability: null,
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_MANUAL_QA',
      artifactType: 'manual_qa_summary',
      content: JSON.stringify({ version: 1, outcome: 'passed' }),
    })
    reserveManualQaVersion(ticketDir, ticket.id, 2, 'generation-v2')

    expect(buildManualQaProjection(ticket.id)).toMatchObject({
      activeVersion: 2,
      completedRoundCount: 1,
      artifactAvailable: false,
      versions: [
        {
          version: 1,
          status: 'completed',
          artifactAvailable: true,
          phaseAttempt: 1,
          outcome: 'passed',
          completedAt: '2026-07-13T00:01:00.000Z',
        },
        {
          version: 2,
          status: 'generating',
          artifactAvailable: false,
          phaseAttempt: null,
          outcome: null,
          completedAt: null,
        },
      ],
    })
  })

  it('allows ticket Manual QA overrides only while Draft', () => {
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'OVR' })
    const ticket = createTicket({ projectId: project.id, title: 'Draft override', manualQaOverride: null })

    expect(updateTicket(ticket.id, { manualQaOverride: true })?.manualQaOverride).toBe(true)
    patchTicket(ticket.id, { status: 'SCANNING_RELEVANT_FILES' })
    expect(() => updateTicket(ticket.id, { manualQaOverride: false })).toThrow(/DRAFT status/)
    expect(() => patchTicket(ticket.id, { manualQaOverride: null })).toThrow(/DRAFT status/)
    expect(getTicketByRef(ticket.id)?.manualQaOverride).toBe(true)
  })

  it('keeps already-started tickets with missing Manual QA locks disabled', () => {
    sqlite.exec('INSERT INTO profiles (manual_qa_enabled) VALUES (1)')
    const repoDir = lockRepoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LEG' })
    const ticket = createTicket({ projectId: project.id, title: 'Legacy active ticket' })
    patchTicket(ticket.id, {
      status: 'CODING',
      startedAt: '2026-07-01T00:00:00.000Z',
      lockedManualQaEnabled: null,
      lockedManualQaSource: null,
    })

    expect(getTicketByRef(ticket.id)).toMatchObject({
      effectiveManualQaEnabled: false,
      effectiveManualQaSource: 'profile',
    })
  })
})

describe('display-only mock tickets', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    mockRepoManager.cleanup()
  })

  it('keeps mock tickets visible, cancelable, and excluded from startup hydration', () => {
    const repoDir = mockRepoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })

    const mockTicket = createTicket({
      projectId: project.id,
      title: 'Display-only mock',
      description: 'Mock tickets should not run.',
    })
    patchTicket(mockTicket.id, {
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
      status: 'SCANNING_RELEVANT_FILES',
    })

    const realTicket = createTicket({
      projectId: project.id,
      title: 'Real running ticket',
      description: 'Real tickets should still hydrate.',
    })
    patchTicket(realTicket.id, {
      status: 'SCANNING_RELEVANT_FILES',
    })

    expect(getTicketByRef(mockTicket.id)?.availableActions).toEqual(['cancel'])
    expect(getTicketByRef(mockTicket.id)?.isDisplayOnlyMock).toBe(true)
    expect(getTicketByRef(realTicket.id)?.isDisplayOnlyMock).toBe(false)
    expect(getTicketByRef(realTicket.id)?.availableActions.length).toBeGreaterThan(0)
    expect(listNonTerminalTickets().map((ticket) => ticket.id)).toEqual([realTicket.id])

    patchTicket(mockTicket.id, { status: 'CANCELED' })
    expect(getTicketByRef(mockTicket.id)?.availableActions).toEqual([])
  })

  it('ignores mock tickets when checking project execution-band conflicts', () => {
    const repoDir = mockRepoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })

    const mockTicket = createTicket({
      projectId: project.id,
      title: 'Mock PR review ticket',
      description: 'This display-only mock should not reserve execution.',
    })
    patchTicket(mockTicket.id, {
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
      status: 'WAITING_PR_REVIEW',
    })

    expect(findProjectExecutionBandConflict(project.id)).toBeNull()

    const realTicket = createTicket({
      projectId: project.id,
      title: 'Real execution ticket',
      description: 'This real ticket should still reserve execution.',
    })
    patchTicket(realTicket.id, {
      status: 'CODING',
    })

    expect(findProjectExecutionBandConflict(project.id)).toMatchObject({
      ticketId: realTicket.id,
      externalId: realTicket.externalId,
      status: 'CODING',
    })
  })
})

describe('ticket error occurrences', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    errorRepoManager.cleanup()
  })

  it('records repeated block/retry cycles as append-only occurrences and exposes them on the public ticket', () => {
    const repoDir = errorRepoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Track repeated errors',
      description: 'Repeated block/retry cycles should keep historical incidents.',
    })

    const firstErrorAt = '2026-03-13T12:00:00.000Z'
    const firstBlocked = recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: 'CODING',
      errorMessage: 'First blocking failure',
      errorCodes: ['FIRST_FAIL'],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'rate_limit_error: Model usage limit reached (HTTP 429)',
        modelId: 'openai/gpt-5.3-codex',
        sessionId: 'ses-limit',
        statusCode: 429,
        providerErrorType: 'rate_limit_error',
        providerErrorMessage: 'Model usage limit reached',
        isRetryable: true,
      },
      occurredAt: firstErrorAt,
    })
    expect(firstBlocked?.occurrenceNumber).toBe(1)

    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      errorMessage: 'First blocking failure',
      xstateSnapshot: JSON.stringify({ context: { previousStatus: 'CODING' } }),
    })

    let publicTicket = getTicketByRef(ticket.id)
    expect(publicTicket?.status).toBe('BLOCKED_ERROR')
    expect(publicTicket?.previousStatus).toBe('CODING')
    expect(publicTicket?.reviewCutoffStatus).toBe('CODING')
    expect(publicTicket?.errorOccurrences).toHaveLength(1)
    expect(publicTicket?.activeErrorOccurrenceId).toBe(firstBlocked?.id)
    expect(publicTicket?.hasPastErrors).toBe(false)
    expect(publicTicket?.errorOccurrences[0]).toMatchObject({
      occurrenceNumber: 1,
      blockedFromStatus: 'CODING',
      errorMessage: 'First blocking failure',
      errorCodes: ['FIRST_FAIL'],
      diagnostics: expect.objectContaining({
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'rate_limit_error: Model usage limit reached (HTTP 429)',
        modelId: 'openai/gpt-5.3-codex',
        sessionId: 'ses-limit',
        statusCode: 429,
        providerErrorType: 'rate_limit_error',
        providerErrorMessage: 'Model usage limit reached',
        isRetryable: true,
      }),
      occurredAt: firstErrorAt,
      resolvedAt: null,
      resolutionStatus: null,
      resumedToStatus: null,
    })

    resolveLatestTicketErrorOccurrence(ticket.id, {
      resolutionStatus: 'RETRIED',
      resumedToStatus: 'CODING',
      resolvedAt: '2026-03-13T12:05:00.000Z',
    })

    patchTicket(ticket.id, {
      status: 'CODING',
      errorMessage: null,
      xstateSnapshot: JSON.stringify({ context: { previousStatus: 'BLOCKED_ERROR' } }),
    })

    const secondErrorAt = '2026-03-13T12:10:00.000Z'
    const secondBlocked = recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: 'REFINING_PRD',
      errorMessage: 'Second blocking failure',
      errorCodes: ['SECOND_FAIL'],
      occurredAt: secondErrorAt,
    })
    expect(secondBlocked?.occurrenceNumber).toBe(2)

    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      errorMessage: 'Second blocking failure',
      xstateSnapshot: JSON.stringify({ context: { previousStatus: 'REFINING_PRD' } }),
    })

    publicTicket = getTicketByRef(ticket.id)
    expect(publicTicket?.errorOccurrences).toHaveLength(2)
    expect(publicTicket?.activeErrorOccurrenceId).toBe(secondBlocked?.id)
    expect(publicTicket?.hasPastErrors).toBe(true)
    expect(publicTicket?.errorOccurrences.map((occurrence) => occurrence.occurrenceNumber)).toEqual([1, 2])
    expect(publicTicket?.errorOccurrences[0]).toMatchObject({
      resolutionStatus: 'RETRIED',
      resumedToStatus: 'CODING',
      resolvedAt: '2026-03-13T12:05:00.000Z',
    })
    expect(publicTicket?.errorOccurrences[1]).toMatchObject({
      occurrenceNumber: 2,
      blockedFromStatus: 'REFINING_PRD',
      errorMessage: 'Second blocking failure',
      errorCodes: ['SECOND_FAIL'],
      resolvedAt: null,
      resolutionStatus: null,
      resumedToStatus: null,
    })

    resolveLatestTicketErrorOccurrence(ticket.id, {
      resolutionStatus: 'CANCELED',
      resumedToStatus: null,
      resolvedAt: '2026-03-13T12:12:00.000Z',
    })

    patchTicket(ticket.id, {
      status: 'CANCELED',
      errorMessage: null,
      xstateSnapshot: JSON.stringify({ context: { previousStatus: 'BLOCKED_ERROR' } }),
    })

    publicTicket = getTicketByRef(ticket.id)
    expect(publicTicket?.status).toBe('CANCELED')
    expect(publicTicket?.reviewCutoffStatus).toBe('REFINING_PRD')
    expect(publicTicket?.errorOccurrences[1]).toMatchObject({
      resolvedAt: '2026-03-13T12:12:00.000Z',
      resolutionStatus: 'CANCELED',
      resumedToStatus: null,
    })
  })
})
