import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Bead } from '../../beads/types'
import type { PreFlightContext } from '../types'
import type { DoctorDeps } from '../doctor'
import { runPreFlightChecks } from '../doctor'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../../../opencode/permissions'
import { TEST } from '../../../test/factories'
import { createShellCommandSpec } from '@shared/commandSpec'
import type { WorktreeChangeEntry, WorktreeChangeSummary } from '../../../git/worktreeChanges'

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'b1',
    title: 'Bead 1',
    prdRefs: ['e1'],
    description: 'desc',
    contextGuidance: { patterns: [], anti_patterns: [] },
    acceptanceCriteria: ['ac1'],
    tests: ['test1'],
    testCommands: [createShellCommandSpec('npm test')],
    priority: 1,
    status: 'pending',
    issueType: 'task',
    externalRef: '',
    labels: [],
    dependencies: { blocked_by: [], blocks: [] },
    targetFiles: [],
    failedIterationNotes: [],
    userRetryNotes: [],
    finalizationFailureNotes: [],
    iteration: 1,
    createdAt: '',
    updatedAt: '',
    completedAt: '',
    startedAt: '',
    beadStartCommit: null,
    ...overrides,
  }
}

const defaultContext: PreFlightContext = {
  lockedMainImplementer: 'model-a',
  lockedMainImplementerVariant: 'high',
  maxIterations: 5,
}

function cleanWorktreeSummary(overrides: Partial<WorktreeChangeSummary> = {}): WorktreeChangeSummary {
  const summary: WorktreeChangeSummary = {
    entries: [],
    committable: [],
    looptroopExcluded: [],
    setupExcluded: [],
    generatedNoise: [],
    hasChanges: false,
    hasCommittableChanges: false,
  }
  return { ...summary, ...overrides }
}

function changeEntry(path: string, category: WorktreeChangeEntry['category'], untracked = false): WorktreeChangeEntry {
  return {
    path,
    indexStatus: untracked ? '?' : ' ',
    worktreeStatus: untracked ? '?' : 'M',
    rawStatus: untracked ? '??' : ' M',
    untracked,
    category,
    ...(category === 'generatedNoise' ? { generatedNoisePattern: `${path.split('/')[0]}/` } : {}),
  }
}

describe('Pre-Flight Doctor', () => {
  let adapter: MockOpenCodeAdapter
  let deps: DoctorDeps

  const ticketPaths = {
    projectRoot: '/tmp/test-project',
    worktreePath: '/tmp/test-worktree',
    ticketDir: '/tmp/test-worktree/.ticket',
    executionLogPath: '/tmp/test-worktree/.ticket/runtime/execution-log.jsonl',
    debugLogPath: '/tmp/test-worktree/.ticket/runtime/execution-log.debug.jsonl',
    aiLogPath: '/tmp/test-worktree/.ticket/runtime/execution-log.ai.jsonl',
    executionSetupDir: '/tmp/test-worktree/.ticket/runtime/execution-setup',
    executionSetupProfilePath: '/tmp/test-worktree/.ticket/runtime/execution-setup-profile.json',
    baseBranch: 'main',
    beadsPath: '/tmp/beads',
  }

  const approvalReceipt = {
    id: 1,
    ticketId: 1,
    phase: 'WAITING_BEADS_APPROVAL' as const,
    phaseAttempt: 1,
    artifactType: 'approval_receipt',
    filePath: null,
    content: '{}',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new MockOpenCodeAdapter()
    deps = {
      fileExists: () => true,
      getTicketPaths: () => ticketPaths,
      getCurrentBranch: () => 'PROJ-1',
      readOriginRemoteUrl: () => 'git@github.com:test/looptroop.git',
      parseGitHubRemoteUrl: () => ({
        owner: 'test',
        repo: 'looptroop',
        slug: 'test/looptroop',
        remoteUrl: 'git@github.com:test/looptroop.git',
      }),
      isGhInstalled: () => true,
      getGhAuthStatus: () => ({ ok: true }),
      getGitHubRepoAccess: () => ({
        ok: true,
        repo: {
          owner: 'test',
          repo: 'looptroop',
          slug: 'test/looptroop',
          remoteUrl: 'git@github.com:test/looptroop.git',
        },
      }),
      getLatestPhaseArtifact: () => approvalReceipt,
      fetchConnectedModelIds: async () => ['model-a', 'model-b'],
      findExecutionBandConflict: () => null,
      getWorktreeChangeSummary: () => cleanWorktreeSummary(),
    }
  })

  it('passes all checks in happy path', async () => {
    const beads = [makeBead()]
    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    expect(report.passed).toBe(true)
    expect(report.criticalFailures).toHaveLength(0)
    const capabilityCheck = report.checks.find((check) => check.name === 'OpenCode Execution Capability')
    expect(capabilityCheck?.result).toBe('pass')
    expect(adapter.sessionCreateCalls).toHaveLength(1)
    expect(adapter.sessionCreateCalls[0]?.options?.permission).toEqual(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
    expect(adapter.promptCalls[0]?.options?.variant).toBe('high')
  })

  it('retries the execution capability probe session before prompting', async () => {
    vi.useFakeTimers()
    try {
      const beads = [makeBead()]
      adapter.mockSessionCreateFailures = [
        new Error('OpenCode returned no session payload'),
        new Error('socket hang up'),
      ]

      const reportPromise = runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

      await vi.runAllTimersAsync()
      const report = await reportPromise

      expect(report.passed).toBe(true)
      expect(adapter.sessionCreateCalls).toHaveLength(3)
      expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['mock-session-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('detects circular dependencies', async () => {
    const b1 = makeBead({ id: 'b1', dependencies: { blocked_by: ['b2'], blocks: [] } })
    const b2 = makeBead({ id: 'b2', dependencies: { blocked_by: ['b1'], blocks: [] } })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, [b1, b2], defaultContext, undefined, deps)

    expect(report.passed).toBe(false)
    const circularCheck = report.criticalFailures.find(c => c.message.includes('Circular'))
    expect(circularCheck).toBeDefined()
  })

  it('detects duplicate bead IDs', async () => {
    const b1 = makeBead({ id: 'dup' })
    const b2 = makeBead({ id: 'dup' })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, [b1, b2], defaultContext, undefined, deps)

    expect(report.passed).toBe(false)
    const dupCheck = report.criticalFailures.find(c => c.message.includes('Duplicate'))
    expect(dupCheck).toBeDefined()
  })

  it('detects no runnable bead when all depend on non-existent', async () => {
    const b1 = makeBead({ id: 'b1', dependencies: { blocked_by: ['nonexistent'], blocks: [] } })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, [b1], defaultContext, undefined, deps)

    expect(report.passed).toBe(false)
    expect(report.criticalFailures.some(c => c.message.includes('dangling'))).toBe(true)
  })

  it('accepts maxIterations = 0 as valid (unlimited)', async () => {
    const beads = [makeBead()]
    const ctx = { ...defaultContext, maxIterations: 0 }
    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, ctx, undefined, deps)

    const budgetCheck = report.checks.find(c => c.name === 'Runtime Budget')
    expect(budgetCheck?.result).toBe('pass')
    expect(budgetCheck?.message).toContain('unlimited')
  })

  it('fails for negative maxIterations', async () => {
    const beads = [makeBead()]
    const ctx = { ...defaultContext, maxIterations: -1 }
    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, ctx, undefined, deps)

    const budgetCheck = report.checks.find(c => c.name === 'Runtime Budget')
    expect(budgetCheck?.result).toBe('fail')
  })

  it('fails when main implementer model is not available', async () => {
    const beads = [makeBead()]
    deps.fetchConnectedModelIds = async () => ['model-b', 'model-c']

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const modelCheck = report.criticalFailures.find(c => c.name === 'Main Implementer Model')
    expect(modelCheck).toBeDefined()
    expect(modelCheck?.message).toContain('not available')
  })

  it('does not fail for missing council members (only main implementer checked)', async () => {
    const beads = [makeBead()]
    deps.fetchConnectedModelIds = async () => ['model-a']

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const modelCheck = report.checks.find(c => c.name === 'Main Implementer Model')
    expect(modelCheck?.result).toBe('pass')
  })

  it('fails when beads approval receipt is missing', async () => {
    const beads = [makeBead()]
    deps.getLatestPhaseArtifact = () => undefined

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const approvalCheck = report.criticalFailures.find(c => c.name === 'Beads Approval')
    expect(approvalCheck).toBeDefined()
    expect(approvalCheck?.message).toContain('not found')
  })

  it('fails when git worktree path does not exist', async () => {
    const beads = [makeBead()]
    deps.fileExists = (p) => p !== '/tmp/test-worktree'

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const gitCheck = report.criticalFailures.find(c => c.name === 'Git Worktree')
    expect(gitCheck).toBeDefined()
    expect(gitCheck?.message).toContain('does not exist')
  })

  it('fails when pre-existing committable project changes are present', async () => {
    const beads = [makeBead()]
    const dirtyEntry = changeEntry('src/changed.cs', 'committable')
    deps.getWorktreeChangeSummary = () => cleanWorktreeSummary({
      entries: [dirtyEntry],
      committable: [dirtyEntry],
      hasChanges: true,
      hasCommittableChanges: true,
    })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const cleanlinessCheck = report.criticalFailures.find(c => c.name === 'Worktree Cleanliness')
    expect(cleanlinessCheck).toBeDefined()
    expect(cleanlinessCheck?.message).toContain('src/changed.cs')
  })

  it('warns but passes when only untracked generated output is present', async () => {
    const beads = [makeBead()]
    const generatedEntry = changeEntry('node_modules/pkg/index.js', 'generatedNoise', true)
    deps.getWorktreeChangeSummary = () => cleanWorktreeSummary({
      entries: [generatedEntry],
      generatedNoise: [generatedEntry],
      hasChanges: true,
    })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    expect(report.passed).toBe(true)
    const warning = report.warnings.find(c => c.name === 'Worktree Cleanliness')
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('node_modules/pkg/index.js')
  })

  it('fails when no main implementer configured', async () => {
    const beads = [makeBead()]
    const ctx = { ...defaultContext, lockedMainImplementer: null }
    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, ctx, undefined, deps)

    const modelCheck = report.criticalFailures.find(c => c.name === 'Main Implementer Model')
    expect(modelCheck).toBeDefined()
    expect(modelCheck?.message).toContain('No main implementer')
  })

  it('detects detached HEAD state', async () => {
    const beads = [makeBead()]
    deps.getCurrentBranch = () => null

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const gitCheck = report.criticalFailures.find(c => c.name === 'Git Worktree')
    expect(gitCheck).toBeDefined()
    expect(gitCheck?.message).toContain('detached HEAD')
  })

  it('reports relevant files as warning when missing', async () => {
    const beads = [makeBead()]
    deps.fileExists = (p) => typeof p === 'string' && !p.includes('relevant-files')

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const rfCheck = report.warnings.find(c => c.name === 'Relevant Files')
    expect(rfCheck).toBeDefined()
    expect(rfCheck?.result).toBe('warning')
    expect(report.criticalFailures.every(c => c.name !== 'Relevant Files')).toBe(true)
  })

  it('fails when another ticket is already in the execution band', async () => {
    const beads = [makeBead()]
    deps.findExecutionBandConflict = () => ({
      ticketId: `${TEST.projectId}:${TEST.shortname}-2`,
      externalId: `${TEST.shortname}-2`,
      title: 'Conflicting execution',
      status: 'CODING',
    })

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const lockCheck = report.criticalFailures.find(c => c.name === 'Project Execution Lock')
    expect(lockCheck).toBeDefined()
    expect(lockCheck?.message).toBe(
      `${TEST.externalId} can’t enter execution yet because ${TEST.shortname}-2 is still running and currently at Implementing. Configured limitation in LoopTroop alpha: Each project may have only one active ticket in the execution band at a time. Finish or cancel ${TEST.shortname}-2, then try again.`,
    )
  })

  it('fails when the execution capability probe does not return the exact OK marker', async () => {
    const beads = [makeBead()]
    adapter.mockResponses.set('mock-session-1', 'NOT OK')

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps)

    const capabilityCheck = report.criticalFailures.find((check) => check.name === 'OpenCode Execution Capability')
    expect(capabilityCheck).toBeDefined()
    expect(capabilityCheck?.message).toContain('unexpected response')
  })

  it('reports rich provider errors from the execution capability probe stream', async () => {
    const beads = [makeBead()]
    const events: unknown[] = []
    adapter.mockResponses.set('mock-session-1', '')
    adapter.mockStreamEvents.set('mock-session-1', [{
      type: 'session_error',
      sessionId: 'mock-session-1',
      error: 'Provider request failed',
      details: {
        name: 'APIError',
        data: {
          message: 'Your authentication token has been invalidated. Please try signing in again.',
          statusCode: 401,
          isRetryable: false,
          responseBody: JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'token_invalidated',
              message: 'Your authentication token has been invalidated. Please try signing in again.',
            },
          }),
        },
      },
    }])

    const report = await runPreFlightChecks(adapter, TEST.ticketId, beads, defaultContext, undefined, deps, {
      onOpenCodeStreamEvent: (event) => events.push(event),
    })

    const capabilityCheck = report.criticalFailures.find((check) => check.name === 'OpenCode Execution Capability')
    expect(capabilityCheck).toBeDefined()
    expect(capabilityCheck?.message).toContain('Your authentication token has been invalidated')
    expect(capabilityCheck?.message).toContain('HTTP 401')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'model-a',
        session: expect.objectContaining({ id: 'mock-session-1' }),
        event: expect.objectContaining({ type: 'session_error' }),
      }),
    ]))
  })
})
