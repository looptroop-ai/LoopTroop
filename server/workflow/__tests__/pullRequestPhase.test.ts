import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  makeBeadsYaml,
  makeInterviewYaml,
  makePrdYaml,
} from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { updateProject } from '../../storage/projects'
import type { OpenCodePromptCompletedEvent, runOpenCodePrompt } from '../runOpenCodePrompt'
import {
  buildPullRequestContext,
  buildManualQaPullRequestSection,
  buildPullRequestPrompt,
  completeCloseUnmerged,
  completeMergedPullRequest,
  handleCreatePullRequest,
  reconcileEarlyMergedPullRequest,
  resolvePullRequestHeadBranch,
  readPullRequestReport,
  refreshPullRequestState,
  PULL_REQUEST_REPORT_ARTIFACT,
  MERGE_REPORT_ARTIFACT,
} from '../phases/pullRequestPhase'
import { EarlyMergeRecoveryManualError } from '../../git/earlyMergedPullRequestRecovery'

const mocks = vi.hoisted(() => ({
  runOpenCodePrompt: vi.fn(),
  runOpenCodeSessionPrompt: vi.fn(),
  pushBranchRef: vi.fn(),
  readGitDiff: vi.fn(),
  createOrUpdateDraftPullRequest: vi.fn(),
  captureGitRecoveryReceipt: vi.fn((input: unknown) => input),
  getPullRequestByNumber: vi.fn(),
  ensureWorktreeClean: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
  tryDeleteRemoteBranch: vi.fn(),
  verifyRemoteBaseContainsCommit: vi.fn(),
  listPullRequestsForBranch: vi.fn(),
  reconcileMergedPullRequestCandidate: vi.fn(),
}))

vi.mock('../runOpenCodePrompt', () => ({
  formatPromptText: (parts: Array<{ type?: string; source?: string; content?: string }>) => {
    if (parts.length === 1 && !parts[0]?.source) return parts[0]?.content ?? ''
    return parts.map((part) => `### ${part.source ?? part.type}\n${part.content ?? ''}`).join('\n\n')
  },
  runOpenCodePrompt: mocks.runOpenCodePrompt,
  runOpenCodeSessionPrompt: mocks.runOpenCodeSessionPrompt,
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../git/push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/push')>()
  return {
    ...actual,
    pushBranchRef: mocks.pushBranchRef,
  }
})

vi.mock('../../git/github', () => ({
  readGitDiff: mocks.readGitDiff,
  createOrUpdateDraftPullRequest: mocks.createOrUpdateDraftPullRequest,
  captureGitRecoveryReceipt: mocks.captureGitRecoveryReceipt,
  getPullRequestByNumber: mocks.getPullRequestByNumber,
  ensureWorktreeClean: mocks.ensureWorktreeClean,
  markPullRequestReady: mocks.markPullRequestReady,
  mergePullRequest: mocks.mergePullRequest,
  tryDeleteRemoteBranch: mocks.tryDeleteRemoteBranch,
  verifyRemoteBaseContainsCommit: mocks.verifyRemoteBaseContainsCommit,
  listPullRequestsForBranch: mocks.listPullRequestsForBranch,
}))

vi.mock('../../git/earlyMergedPullRequestRecovery', () => ({
  EarlyMergeRecoveryManualError: class EarlyMergeRecoveryManualError extends Error {
    recovery: {
      reason: 'missing_proof' | 'conflict' | 'local_work_preserved'
      message: string
      recoveryWorktreePath: string | null
      recoveryWorktreeBaseHead?: string | null
      conflictPaths: string[]
    }
    proof: unknown

    constructor(recovery: {
      reason: 'missing_proof' | 'conflict' | 'local_work_preserved'
      message: string
      recoveryWorktreePath: string | null
      recoveryWorktreeBaseHead?: string | null
      conflictPaths: string[]
    } = { reason: 'missing_proof', message: 'Manual recovery required.', recoveryWorktreePath: null, conflictPaths: [] }, proof: unknown = null) {
      super(recovery.message)
      this.recovery = recovery
      this.proof = proof
    }
  },
  reconcileMergedPullRequestCandidate: mocks.reconcileMergedPullRequestCandidate,
}))

describe('pull request drafting context', () => {
  const repoManager = createTestRepoManager('pull-request-phase-')

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readGitDiff.mockReturnValue({
      stat: '1 file changed, 2 insertions(+)',
      nameStatus: 'M\tsrc/example.ts',
      patch: 'diff --git a/src/example.ts b/src/example.ts',
      patchTruncated: false,
      patchError: null,
    })
    mocks.pushBranchRef.mockReturnValue({ pushed: true })
    mocks.createOrUpdateDraftPullRequest.mockReturnValue({
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Draft PR',
      body: 'Body',
      state: 'draft',
      baseRefName: 'main',
      headRefName: 'TEST-1',
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    })
    mocks.ensureWorktreeClean.mockReturnValue(undefined)
    mocks.listPullRequestsForBranch.mockResolvedValue([])
    mocks.reconcileMergedPullRequestCandidate.mockReset()
    mocks.verifyRemoteBaseContainsCommit.mockReturnValue({
      baseBranch: 'main',
      verifiedCommitSha: 'candidate123',
      remoteBaseHead: 'remote-base-sha',
    })
    mocks.tryDeleteRemoteBranch.mockReturnValue({ deleted: true, warning: null })
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  async function createPullRequestReadyTicket(overrides: { structuredRetryCount?: number } = {}) {
    const setup = await createInitializedTestTicket(repoManager, {
      title: 'Draft concise PR',
      description: 'Explain the implementation without replaying planning context.',
    })

    writeFileSync(`${setup.paths.ticketDir}/prd.yaml`, makePrdYaml({
      ticketId: setup.ticket.externalId,
      problemStatement: 'Use PRD requirements as the reviewer-facing why.',
    }))
    upsertLatestPhaseArtifact(
      setup.ticket.id,
      'integration_report',
      'INTEGRATING_CHANGES',
      JSON.stringify({
        candidateCommitSha: 'candidate123',
        mergeBase: 'base123',
      }),
    )
    upsertLatestPhaseArtifact(
      setup.ticket.id,
      'final_test_report',
      'RUNNING_FINAL_TEST',
      JSON.stringify({ status: 'passed', summary: 'Final tests passed.' }),
    )

    return {
      ...setup,
      context: {
        ...setup.context,
        lockedStructuredRetryCount: overrides.structuredRetryCount ?? 1,
      },
    }
  }

  function buildMergeCompletionInput(
    ticket: { id: string; externalId: string },
    context: { externalId: string },
    prInfo: { url: string; title: string; body: string; createdAt: string; updatedAt: string },
    skipRemoteMerge: boolean,
  ): Parameters<typeof completeMergedPullRequest>[0] {
    return {
      skipRemoteMerge,
      ticketId: ticket.id,
      externalId: ticket.externalId,
      projectPath: context.externalId,
      baseBranch: 'main',
      headBranch: ticket.externalId,
      candidateCommitSha: 'candidate123',
      prReport: {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        baseBranch: 'main',
        headBranch: ticket.externalId,
        candidateCommitSha: 'candidate123',
        prNumber: 42,
        prUrl: prInfo.url,
        prState: 'open',
        prHeadSha: 'candidate123',
        title: prInfo.title,
        body: prInfo.body,
        createdAt: prInfo.createdAt,
        updatedAt: prInfo.updatedAt,
        mergedAt: null,
        closedAt: null,
        message: 'Draft PR ready.',
      },
    }
  }

  function validCandidateAuditResponse(path = 'src/example.ts') {
    return [
      'files:',
      `  - path: ${path}`,
      '    decision: include',
      '    reason: Source change belongs in the requested PR.',
    ].join('\n')
  }

  function validPullRequestDraftResponse(title = 'Valid PR draft') {
    return [
      `title: ${title}`,
      'summary: Summarized the implementation.',
      'why: The ticket requested this behavior.',
      'what_changed: Updated the relevant code path.',
      'validation: Final tests passed.',
      'follow_ups: []',
    ].join('\n')
  }

  function queueValidDrafts(prefix: string) {
    mocks.runOpenCodePrompt
      .mockResolvedValueOnce({ session: { id: `${prefix}-audit` }, response: validCandidateAuditResponse(), messages: [] })
      .mockResolvedValueOnce({ session: { id: `${prefix}-draft` }, response: validPullRequestDraftResponse(), messages: [] })
  }

  function makeMergedPullRequest(number = 42) {
    return {
      number,
      url: `https://github.example/pulls/${number}`,
      title: 'Merged candidate',
      body: 'Already merged.',
      state: 'merged' as const,
      baseRefName: 'main',
      headRefName: 'TEST-1',
      headRefOid: 'a'.repeat(40),
      mergeCommitSha: 'd'.repeat(40),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: '2026-01-01T00:05:00.000Z',
    }
  }

  function makeEarlyMergeProof(pr: ReturnType<typeof makeMergedPullRequest>, candidateCommitSha: string, remoteBaseHead = '2'.repeat(40)) {
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      candidateCommitSha,
      candidateTreeSha: 'f'.repeat(40),
      mergedHeadSha: pr.headRefOid,
      mergedHeadTreeSha: '1'.repeat(40),
      landedCommitSha: pr.mergeCommitSha,
      remoteBaseHead,
    }
  }

  function mockCorrectedRecovery(pr: ReturnType<typeof makeMergedPullRequest>, candidateCommitSha: string, correctedCandidateSha: string) {
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha,
      recoveryWorktreePath: null,
      proof: makeEarlyMergeProof(pr, candidateCommitSha),
    })
  }

  function writeIntegrationCandidate(ticketId: string, candidateCommitSha: string, mergeBase = 'e'.repeat(40), record: Record<string, unknown> = {}) {
    upsertLatestPhaseArtifact(ticketId, 'integration_report', 'INTEGRATING_CHANGES', JSON.stringify({
      ...record,
      candidateCommitSha,
      mergeBase,
    }))
  }

  function makeEarlyMergeInput(input: {
    ticket: { id: string; externalId: string }
    repoDir: string
    worktreePath: string
    candidateCommitSha: string
    pr: ReturnType<typeof makeMergedPullRequest>
    phase?: 'CREATING_PULL_REQUEST' | 'WAITING_PR_REVIEW'
  }): Parameters<typeof reconcileEarlyMergedPullRequest>[0] {
    return {
      ticketId: input.ticket.id,
      phase: input.phase ?? 'CREATING_PULL_REQUEST',
      projectPath: input.repoDir,
      worktreePath: input.worktreePath,
      externalId: input.ticket.externalId,
      baseBranch: 'main',
      headBranch: input.ticket.externalId,
      candidateCommitSha: input.candidateCommitSha,
      pr: input.pr,
    }
  }

  function makeEarlyMergeReport(ticket: { externalId: string }, pr: ReturnType<typeof makeMergedPullRequest>, candidateCommitSha: string, overrides: Record<string, unknown> = {}) {
    return {
      status: 'manual_recovery_required',
      recordedAt: new Date().toISOString(),
      reason: 'missing_proof',
      baseBranch: 'main',
      activeHeadBranch: ticket.externalId,
      ticketBranch: ticket.externalId,
      prNumber: pr.number,
      prUrl: pr.url,
      candidateCommitSha,
      candidateTreeSha: null,
      prHeadSha: pr.headRefOid,
      prHeadTreeSha: null,
      landedCommitSha: pr.mergeCommitSha,
      remoteBaseHead: null,
      correctedCandidateSha: null,
      recoveryWorktreePath: null,
      recoveryWorktreeBaseHead: null,
      conflictPaths: [],
      message: 'Manual recovery required.',
      ...overrides,
      correctionBranch: overrides.correctionBranch ?? (overrides.status === 'corrected'
        ? `looptroop/early-merge/pr-${pr.number}-${candidateCommitSha.slice(0, 12)}`
        : null),
    }
  }

  it('skips an older merged PR after correction and creates a new PR from the revalidated candidate', async () => {
    resetTestDb()
    const { ticket, context, repoDir, paths } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const originalCandidate = 'b'.repeat(40)
    const correctedCandidate = 'c'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, originalCandidate)
    mockCorrectedRecovery(mergedPr, originalCandidate, correctedCandidate)

    await expect(reconcileEarlyMergedPullRequest(makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: originalCandidate, pr: mergedPr,
    }))).resolves.toBe('corrected')

    const resquashedCandidate = 'd'.repeat(40)
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    upsertLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES', JSON.stringify({
      status: 'passed',
      baseBranch: 'main',
      candidateCommitSha: resquashedCandidate,
      mergeBase: '2'.repeat(40),
      earlyMergeCorrectionBranch: correctionBranch,
      pushed: false,
      pushDeferred: true,
      pushError: null,
    }))
    upsertLatestPhaseArtifact(ticket.id, 'final_test_report', 'RUNNING_FINAL_TEST', JSON.stringify({
      status: 'passed',
      candidateCommitSha: resquashedCandidate,
      summary: 'Corrective candidate passed final tests.',
    }))
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha: resquashedCandidate,
      recoveryWorktreePath: null,
      proof: makeEarlyMergeProof(mergedPr, originalCandidate),
    })
    mocks.listPullRequestsForBranch.mockImplementation(async (_worktree, branch) =>
      branch === ticket.externalId ? [mergedPr] : [])
    queueValidDrafts('corrected-candidate')

    const sendEvent = vi.fn()
    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledTimes(2)
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenLastCalledWith(expect.objectContaining({
      candidateCommitSha: originalCandidate,
      validatedCandidate: { commitSha: resquashedCandidate, baseHead: '2'.repeat(40) },
    }))
    expect(mocks.pushBranchRef).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: resquashedCandidate,
      destinationBranch: correctionBranch,
    }))
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      branchName: correctionBranch,
    }))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'PULL_REQUEST_READY' })
    expect(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')?.content).toContain('corrected')
    expect(JSON.stringify(mocks.runOpenCodePrompt.mock.calls)).not.toContain('recoveryWorktreePath')
  })

  it('validates a corrective PR head from stored lineage after candidate re-squash', async () => {
    resetTestDb()
    const { ticket } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const reSquashedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    writeIntegrationCandidate(ticket.id, reSquashedCandidate, '2'.repeat(40), {
      earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, originalCandidate, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: 'c'.repeat(40),
      }),
    ))

    expect(resolvePullRequestHeadBranch(ticket.id, ticket.branchName ?? ticket.externalId, {
      baseBranch: 'main',
      headBranch: correctionBranch,
      prNumber: mergedPr.number + 1,
      candidateCommitSha: reSquashedCandidate,
    })).toBe(correctionBranch)
    expect(() => resolvePullRequestHeadBranch(ticket.id, ticket.branchName ?? ticket.externalId, {
      baseBranch: 'main',
      headBranch: 'other-branch',
      prNumber: mergedPr.number + 1,
      candidateCommitSha: reSquashedCandidate,
    })).toThrow('no matching stored early-merge correction proof')
  })

  it.each([
    {
      label: 'recovery checkout without a recorded base',
      overrides: { status: 'manual_recovery_required', recoveryWorktreePath: '/tmp/recovery' },
    },
    {
      label: 'correction branch that does not match its proof',
      overrides: { status: 'corrected', correctionBranch: 'looptroop/early-merge/wrong' },
    },
    {
      label: 'manual correction branch without a candidate',
      overrides: {
        status: 'manual_recovery_required',
        correctionBranch: 'looptroop/early-merge/pr-42-bbbbbbbbbbbb',
        correctedCandidateSha: '',
      },
    },
  ])('rejects invalid stored recovery lineage: $label', async ({ overrides }) => {
    resetTestDb()
    const { ticket } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const reSquashedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    writeIntegrationCandidate(ticket.id, reSquashedCandidate, '2'.repeat(40), {
      earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, originalCandidate, {
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: 'c'.repeat(40),
        ...overrides,
      }),
    ))

    expect(() => resolvePullRequestHeadBranch(ticket.id, ticket.branchName ?? ticket.externalId, {
      baseBranch: 'main',
      headBranch: correctionBranch,
      prNumber: mergedPr.number + 1,
      candidateCommitSha: reSquashedCandidate,
    })).toThrow('no matching stored early-merge correction proof')
  })

  it.each(['equivalent', 'already_landed'] as const)(
    'resumes a successor corrective PR after a %s result was saved before merge completion',
    async (status) => {
      resetTestDb()
      const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
      const ticketBranch = ticket.branchName?.trim() || ticket.externalId
      const priorCandidate = 'b'.repeat(40)
      const currentCandidate = 'c'.repeat(40)
      const correctionBranch = `looptroop/early-merge/pr-42-${priorCandidate.slice(0, 12)}`
      const mergedPr = { ...makeMergedPullRequest(43), headRefName: correctionBranch }
      writeIntegrationCandidate(ticket.id, currentCandidate, '2'.repeat(40), {
        status: 'pending_revalidation',
        earlyMergeCorrectionBranch: correctionBranch,
      })
      const priorRecovery = makeEarlyMergeReport(ticket, makeMergedPullRequest(42), priorCandidate, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: currentCandidate,
      })
      upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'WAITING_PR_REVIEW', JSON.stringify(priorRecovery))
      const proof = makeEarlyMergeProof(mergedPr, currentCandidate, '9'.repeat(40))
      const result = status === 'equivalent'
        ? { kind: 'equivalent' as const, proof: { ...proof, mergedHeadTreeSha: proof.candidateTreeSha } }
        : { kind: 'already_landed' as const, proof, remoteBaseTreeSha: '8'.repeat(40) }
      mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce(result)
      const input = {
        ...makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: currentCandidate, pr: mergedPr }),
        headBranch: correctionBranch,
        ticketBranch,
      }

      // PR #43 replaces PR #42's recovery artifact, then a restart retries from #43's result.
      await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe(status)
      const recoveryReport = JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)
      expect(recoveryReport).toMatchObject({
        status,
        prNumber: 43,
        activeHeadBranch: correctionBranch,
        ticketBranch,
        correctionBranch: null,
      })
      await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe(status)

      expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledOnce()
      expect(JSON.parse(getLatestPhaseArtifact(ticket.id, MERGE_REPORT_ARTIFACT, 'WAITING_PR_REVIEW')!.content))
        .toMatchObject({ candidateCommitSha: currentCandidate, headBranch: correctionBranch, prNumber: 43 })
      const pullRequestReport = readPullRequestReport(ticket.id)!
      expect(pullRequestReport.headBranch).toBe(correctionBranch)
      expect(resolvePullRequestHeadBranch(ticket.id, ticketBranch, pullRequestReport)).toBe(correctionBranch)
    },
  )

  it('preserves a successor PR active head through conflict and retries using its retained checkout base', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const ticketBranch = ticket.branchName?.trim() || ticket.externalId
    const originalCandidate = 'b'.repeat(40)
    const currentCandidate = 'c'.repeat(40)
    const correctionBranch = `looptroop/early-merge/pr-42-${originalCandidate.slice(0, 12)}`
    const mergedPr42 = makeMergedPullRequest(42)
    const mergedPr43 = { ...makeMergedPullRequest(43), headRefName: correctionBranch }
    writeIntegrationCandidate(ticket.id, currentCandidate, '2'.repeat(40), {
      status: 'pending_revalidation',
      earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr42, originalCandidate, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: 'd'.repeat(40),
      }),
    ))
    const input = {
      ...makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: currentCandidate, pr: mergedPr43 }),
      headBranch: correctionBranch,
      ticketBranch,
    }
    const currentProof = makeEarlyMergeProof(mergedPr43, currentCandidate, 'e'.repeat(40))
    mocks.reconcileMergedPullRequestCandidate.mockRejectedValueOnce(new EarlyMergeRecoveryManualError({
      reason: 'conflict',
      message: 'Resolve the successor PR conflict in the recovery checkout.',
      recoveryWorktreePath: '/tmp/recovery-on-r',
      recoveryWorktreeBaseHead: 'd'.repeat(40),
      conflictPaths: ['src/example.ts'],
    }, currentProof))

    await expect(reconcileEarlyMergedPullRequest(input)).rejects.toThrow('successor PR conflict')
    const manualReport = JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)
    expect(manualReport).toMatchObject({
      status: 'manual_recovery_required',
      prNumber: 43,
      candidateCommitSha: currentCandidate,
      activeHeadBranch: correctionBranch,
      correctionBranch: null,
      remoteBaseHead: 'e'.repeat(40),
      recoveryWorktreePath: '/tmp/recovery-on-r',
      recoveryWorktreeBaseHead: 'd'.repeat(40),
    })
    expect(resolvePullRequestHeadBranch(ticket.id, ticketBranch, {
      baseBranch: 'main',
      headBranch: correctionBranch,
      prNumber: 43,
      candidateCommitSha: currentCandidate,
    })).toBe(correctionBranch)

    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha: 'a'.repeat(40),
      recoveryWorktreePath: null,
      proof: currentProof,
    })
    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('corrected')

    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenLastCalledWith(expect.objectContaining({
      candidateCommitSha: currentCandidate,
      previousRecoveryBaseHead: 'd'.repeat(40),
    }))
    const correctedReport = JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)
    expect(correctedReport).toMatchObject({
      prNumber: 43,
      activeHeadBranch: correctionBranch,
      correctionBranch: `looptroop/early-merge/pr-43-${currentCandidate.slice(0, 12)}`,
      correctedCandidateSha: 'a'.repeat(40),
    })
  })

  it('re-dispatches correction readiness after a crash between corrective artifacts and the event', async () => {
    resetTestDb()
    const { ticket, context, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const correctedCandidate = 'c'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, originalCandidate)
    mockCorrectedRecovery(mergedPr, originalCandidate, correctedCandidate)
    const recoveryInput = makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: originalCandidate, pr: mergedPr })

    await expect(reconcileEarlyMergedPullRequest(recoveryInput)).resolves.toBe('corrected')
    const pending = JSON.parse(getLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES')!.content)
    expect(pending).toMatchObject({ status: 'pending_revalidation', candidateCommitSha: correctedCandidate })

    const sendEvent = vi.fn()
    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'EARLY_MERGE_CORRECTION_READY' })
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledOnce()
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).not.toHaveBeenCalled()
    expect(mocks.listPullRequestsForBranch).toHaveBeenCalledOnce()
  })

  it('reuses the recorded corrective candidate when waiting-review recovery retries after a crash', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const correctedCandidate = 'c'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, originalCandidate)
    mockCorrectedRecovery(mergedPr, originalCandidate, correctedCandidate)
    const recoveryInput = makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: originalCandidate, pr: mergedPr,
      phase: 'WAITING_PR_REVIEW',
    })

    await expect(reconcileEarlyMergedPullRequest(recoveryInput)).resolves.toBe('corrected')
    mockCorrectedRecovery(mergedPr, originalCandidate, correctedCandidate)
    await expect(reconcileEarlyMergedPullRequest(recoveryInput)).resolves.toBe('corrected')

    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledTimes(2)
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES')!.content))
      .toMatchObject({ status: 'pending_revalidation', candidateCommitSha: correctedCandidate })
  })

  it('persists conflict details and instructions for manual resolution', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, originalCandidate)
    mocks.reconcileMergedPullRequestCandidate.mockRejectedValueOnce(new EarlyMergeRecoveryManualError({
      reason: 'conflict',
      message: 'The A-to-B patch conflicted. Recovery checkout remains at /tmp/recovery; resolve it, stage your changes, commit once, then retry Verify.',
      recoveryWorktreePath: '/tmp/recovery',
      recoveryWorktreeBaseHead: '2'.repeat(40),
      conflictPaths: ['src/example.ts'],
    }))

    await expect(reconcileEarlyMergedPullRequest(makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: originalCandidate, pr: mergedPr,
    }))).rejects.toThrow('stage your changes')

    const report = JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)
    expect(report).toMatchObject({
      status: 'manual_recovery_required',
      reason: 'conflict',
      recoveryWorktreePath: '/tmp/recovery',
      conflictPaths: ['src/example.ts'],
    })
    expect(report.message).toContain('stage your changes')
    expect(readPullRequestReport(ticket.id)).toMatchObject({
      prNumber: mergedPr.number,
      prState: 'merged',
      prHeadSha: mergedPr.headRefOid,
      candidateCommitSha: originalCandidate,
    })
    expect(getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'CREATING_PULL_REQUEST')).toBeDefined()
  })

  it('rechecks a saved conflict on retry while preserving its checkout', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const candidateCommitSha = 'b'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, candidateCommitSha)
    const input = makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, candidateCommitSha, { message: 'Proof is unavailable.' }),
    ))
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'equivalent',
      proof: { ...makeEarlyMergeProof(mergedPr, candidateCommitSha), mergedHeadTreeSha: 'f'.repeat(40) },
    })

    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('equivalent')
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledOnce()
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content)).toMatchObject({
      status: 'passed',
      disposition: 'merged',
      candidateCommitSha,
      prHeadSha: mergedPr.headRefOid,
      candidateTreeSha: 'f'.repeat(40),
      prHeadTreeSha: 'f'.repeat(40),
    })

    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, candidateCommitSha, {
        reason: 'conflict',
        recoveryWorktreePath: paths.ticketDir,
      recoveryWorktreeBaseHead: '2'.repeat(40),
        conflictPaths: [],
        remoteBaseHead: '2'.repeat(40),
        message: 'The conflict checkout was resolved manually.',
      }),
    ))
    mocks.reconcileMergedPullRequestCandidate.mockRejectedValueOnce(new EarlyMergeRecoveryManualError({
      reason: 'conflict',
      message: 'The recovery checkout still needs a committed resolution.',
      recoveryWorktreePath: paths.ticketDir,
      recoveryWorktreeBaseHead: '2'.repeat(40),
      conflictPaths: [],
    }))

    await expect(reconcileEarlyMergedPullRequest(input)).rejects.toThrow('still needs a committed resolution')
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledTimes(2)
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenLastCalledWith(expect.objectContaining({
      previousRecoveryBaseHead: '2'.repeat(40),
    }))
  })

  it('refreshes a validated saved correction when the remote base has advanced', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const correctedCandidate = 'c'.repeat(40)
    const refreshedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    writeIntegrationCandidate(ticket.id, correctedCandidate, '2'.repeat(40), {
      status: 'passed', earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, originalCandidate, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: correctedCandidate,
      }),
    ))
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha: refreshedCandidate,
      recoveryWorktreePath: null,
      proof: makeEarlyMergeProof(mergedPr, originalCandidate, '3'.repeat(40)),
    })

    await expect(reconcileEarlyMergedPullRequest(makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: correctedCandidate, pr: mergedPr,
    }))).resolves.toBe('corrected')

    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidateCommitSha: originalCandidate,
    }))
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES')!.content))
      .toMatchObject({ status: 'pending_revalidation', candidateCommitSha: refreshedCandidate })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'final_test_report', 'RUNNING_FINAL_TEST')!.content))
      .toMatchObject({ status: 'pending', candidateCommitSha: refreshedCandidate })
  })

  it.each(['equivalent', 'already_landed'] as const)('records the delivered corrective candidate when proof uses an earlier candidate (%s)', async (kind) => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const validatedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    writeIntegrationCandidate(ticket.id, validatedCandidate, '2'.repeat(40), {
      status: 'passed', earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, originalCandidate, {
        status: 'corrected', reason: 'corrective_delta', correctedCandidateSha: 'c'.repeat(40),
        candidateTreeSha: 'f'.repeat(40), prHeadTreeSha: '1'.repeat(40), remoteBaseHead: '2'.repeat(40),
      }),
    ))
    const proof = makeEarlyMergeProof(mergedPr, originalCandidate)
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce(kind === 'equivalent'
      ? { kind, proof: { ...proof, candidateTreeSha: proof.mergedHeadTreeSha } }
      : { kind, proof, remoteBaseTreeSha: '3'.repeat(40) })
    const input = makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: validatedCandidate, pr: mergedPr,
    })

    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe(kind)
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, MERGE_REPORT_ARTIFACT, 'WAITING_PR_REVIEW')!.content))
      .toMatchObject({ candidateCommitSha: validatedCandidate })
    expect(readPullRequestReport(ticket.id)?.candidateCommitSha).toBe(validatedCandidate)
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content))
      .toMatchObject({ candidateCommitSha: originalCandidate })
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      candidateCommitSha: originalCandidate,
      validatedCandidate: { commitSha: validatedCandidate, baseHead: '2'.repeat(40) },
    }))
  })

  it('refreshes a passed correction before pushing when the base advances during validation', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const validatedCorrection = 'c'.repeat(40)
    const refreshedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    const correctionBranch = `looptroop/early-merge/pr-${mergedPr.number}-${originalCandidate.slice(0, 12)}`
    writeIntegrationCandidate(ticket.id, validatedCorrection, '2'.repeat(40), {
      status: 'passed', earlyMergeCorrectionBranch: correctionBranch,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, originalCandidate, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: 'f'.repeat(40),
        prHeadTreeSha: '1'.repeat(40),
        remoteBaseHead: '2'.repeat(40),
        correctedCandidateSha: validatedCorrection,
      }),
    ))
    mocks.listPullRequestsForBranch.mockResolvedValueOnce([mergedPr])
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha: refreshedCandidate,
      recoveryWorktreePath: null,
      proof: makeEarlyMergeProof(mergedPr, originalCandidate, '3'.repeat(40)),
    })

    const sendEvent = vi.fn()
    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidateCommitSha: originalCandidate,
    }))
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES')!.content))
      .toMatchObject({ status: 'pending_revalidation', candidateCommitSha: refreshedCandidate })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'final_test_report', 'RUNNING_FINAL_TEST')!.content))
      .toMatchObject({ status: 'pending', candidateCommitSha: refreshedCandidate })
    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'EARLY_MERGE_CORRECTION_READY' })
    expect(mocks.pushBranchRef).not.toHaveBeenCalled()
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
  })

  it('does not treat an older merged PR as current when a newer draft exists', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const newerDraft = {
      ...makeMergedPullRequest(43),
      state: 'draft' as const,
      headRefName: ticket.externalId,
      mergeCommitSha: null,
      mergedAt: null,
    }
    mocks.listPullRequestsForBranch.mockResolvedValue([newerDraft, makeMergedPullRequest(42)])
    queueValidDrafts('newer-draft')

    const sendEvent = vi.fn()
    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.reconcileMergedPullRequestCandidate).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).toHaveBeenCalledOnce()
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'PULL_REQUEST_READY' })
  })

  it('retries a saved manual conflict against its recorded base and skips an unrelated candidate', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const originalCandidate = 'b'.repeat(40)
    const nextCandidate = 'c'.repeat(40)
    const correctedCandidate = 'd'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, originalCandidate)
    const recoveryProof = makeEarlyMergeProof(mergedPr, originalCandidate, 'e'.repeat(40))
    mocks.reconcileMergedPullRequestCandidate.mockRejectedValueOnce(new EarlyMergeRecoveryManualError({
      reason: 'conflict',
      message: 'Resolve and commit the original candidate conflict manually.',
      recoveryWorktreePath: paths.worktreePath,
      recoveryWorktreeBaseHead: 'd'.repeat(40),
      conflictPaths: ['src/example.ts'],
    }, recoveryProof))
    const originalInput = makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha: originalCandidate, pr: mergedPr,
    })
    await expect(reconcileEarlyMergedPullRequest(originalInput)).rejects.toThrow('Resolve and commit the original candidate conflict')

    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'corrected',
      correctedCandidateSha: correctedCandidate,
      recoveryWorktreePath: null,
      proof: recoveryProof,
    })
    await expect(reconcileEarlyMergedPullRequest(originalInput))
      .resolves.toBe('corrected')
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenLastCalledWith(expect.objectContaining({
      candidateCommitSha: originalCandidate,
      previousRecoveryBaseHead: 'd'.repeat(40),
    }))

    writeIntegrationCandidate(ticket.id, nextCandidate)
    await expect(reconcileEarlyMergedPullRequest({ ...originalInput, candidateCommitSha: nextCandidate }))
      .resolves.toBe('skip')
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content))
      .toMatchObject({ status: 'corrected', candidateCommitSha: originalCandidate, correctedCandidateSha: correctedCandidate })
  })

  it.each(['missing', 'malformed', 'incomplete'] as const)(
    'fails closed when corrective revalidation has a %s recovery artifact',
    async (artifactState) => {
      resetTestDb()
      const { ticket, context, repoDir, paths } = await createPullRequestReadyTicket()
      const candidateCommitSha = 'b'.repeat(40)
      const mergedPr = makeMergedPullRequest()
      writeIntegrationCandidate(ticket.id, candidateCommitSha, 'e'.repeat(40), { status: 'pending_revalidation' })
      if (artifactState !== 'missing') {
        upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', artifactState === 'malformed'
          ? '{'
          : JSON.stringify(makeEarlyMergeReport(ticket, mergedPr, candidateCommitSha, {
            status: 'corrected',
            reason: 'corrective_delta',
            correctedCandidateSha: 'c'.repeat(40),
          })))
      }
      const sendEvent = vi.fn()

      await expect(handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal))
        .rejects.toThrow('pending revalidation')
      await expect(reconcileEarlyMergedPullRequest(makeEarlyMergeInput({
        ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr,
      }))).rejects.toThrow('pending revalidation')
      expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
      expect(mocks.pushBranchRef).not.toHaveBeenCalled()
      expect(mocks.listPullRequestsForBranch).not.toHaveBeenCalled()
      expect(mocks.reconcileMergedPullRequestCandidate).not.toHaveBeenCalled()
    },
  )

  it('records and replays already-landed proof with the actual candidate, PR, and remote-base trees', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const candidateCommitSha = 'b'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, candidateCommitSha)
    const proof = {
      ...makeEarlyMergeProof(mergedPr, candidateCommitSha, '9'.repeat(40)),
      candidateTreeSha: '1'.repeat(40),
      mergedHeadTreeSha: '2'.repeat(40),
    }
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'already_landed',
      proof,
      remoteBaseTreeSha: '3'.repeat(40),
    })
    const input = makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr })

    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('already_landed')

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)).toMatchObject({
      status: 'already_landed',
      reason: 'already_landed',
      candidateCommitSha,
      candidateTreeSha: '1'.repeat(40),
      prHeadSha: mergedPr.headRefOid,
      prHeadTreeSha: '2'.repeat(40),
      landedCommitSha: mergedPr.mergeCommitSha,
      remoteBaseHead: '9'.repeat(40),
      remoteBaseTreeSha: '3'.repeat(40),
    })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content)).toMatchObject({
      proofKind: 'already_landed',
      candidateTreeSha: '1'.repeat(40),
      prHeadTreeSha: '2'.repeat(40),
      remoteBaseHead: '9'.repeat(40),
      remoteBaseTreeSha: '3'.repeat(40),
    })

    mocks.reconcileMergedPullRequestCandidate.mockClear()
    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('already_landed')
    expect(mocks.reconcileMergedPullRequestCandidate).not.toHaveBeenCalled()
  })

  it('records and replays completion when manual recovery leaves no further changes', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const candidateCommitSha = 'b'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, candidateCommitSha)
    const proof = {
      ...makeEarlyMergeProof(mergedPr, candidateCommitSha, '9'.repeat(40)),
      candidateTreeSha: '1'.repeat(40),
      mergedHeadTreeSha: '2'.repeat(40),
    }
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'already_landed',
      manualResolutionNoChange: true,
      proof,
      remoteBaseTreeSha: '3'.repeat(40),
    })
    const input = makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr })

    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('already_landed')

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)).toMatchObject({
      status: 'already_landed', reason: 'manual_resolution_no_change',
      remoteBaseHead: '9'.repeat(40), remoteBaseTreeSha: '3'.repeat(40),
    })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content)).toMatchObject({
      proofKind: 'manual_resolution_no_change', remoteBaseTreeSha: '3'.repeat(40),
      message: expect.stringContaining('no additional changes'),
    })

    mocks.reconcileMergedPullRequestCandidate.mockClear()
    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('already_landed')
    expect(mocks.reconcileMergedPullRequestCandidate).not.toHaveBeenCalled()
  })

  it('does not replay an equivalent proof after the merged PR identity changes', async () => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const candidateCommitSha = 'b'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, candidateCommitSha)
    const input = makeEarlyMergeInput({ ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr })
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'equivalent', proof: makeEarlyMergeProof(mergedPr, candidateCommitSha),
    })
    await expect(reconcileEarlyMergedPullRequest(input)).resolves.toBe('equivalent')

    mocks.reconcileMergedPullRequestCandidate.mockClear()
    const changedPr = {
      ...mergedPr,
      headRefOid: 'f'.repeat(40),
      mergeCommitSha: 'e'.repeat(40),
    }
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'equivalent', proof: makeEarlyMergeProof(changedPr, candidateCommitSha),
    })
    await expect(reconcileEarlyMergedPullRequest({ ...input, pr: changedPr })).resolves.toBe('equivalent')
    expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledOnce()
  })

  it.each(['corrected', 'already_landed'] as const)('uses refreshed proof when rebuilding corrective artifacts after a crash (%s)', async (kind) => {
    resetTestDb()
    const { ticket, repoDir, paths } = await createPullRequestReadyTicket()
    const candidateCommitSha = 'b'.repeat(40)
    const correctedCandidateSha = 'c'.repeat(40)
    const mergedPr = makeMergedPullRequest()
    writeIntegrationCandidate(ticket.id, candidateCommitSha, 'e'.repeat(40), {
      earlyMergeCorrectionBranch: `looptroop/early-merge/pr-${mergedPr.number}-${candidateCommitSha.slice(0, 12)}`,
    })
    upsertLatestPhaseArtifact(ticket.id, 'early_merge_recovery', 'CREATING_PULL_REQUEST', JSON.stringify(
      makeEarlyMergeReport(ticket, mergedPr, candidateCommitSha, {
        status: 'corrected',
        reason: 'corrective_delta',
        candidateTreeSha: '1'.repeat(40),
        prHeadTreeSha: '2'.repeat(40),
        remoteBaseHead: '3'.repeat(40),
        correctedCandidateSha,
      }),
    ))
    const proof = {
      ...makeEarlyMergeProof(mergedPr, candidateCommitSha, '9'.repeat(40)),
      candidateTreeSha: 'a'.repeat(40),
      mergedHeadTreeSha: 'b'.repeat(40),
    }
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce(kind === 'corrected'
      ? { kind, correctedCandidateSha, recoveryWorktreePath: null, proof }
      : { kind, remoteBaseTreeSha: 'd'.repeat(40), proof })

    await expect(reconcileEarlyMergedPullRequest(makeEarlyMergeInput({
      ticket, repoDir, worktreePath: paths.worktreePath, candidateCommitSha, pr: mergedPr,
    }))).resolves.toBe(kind)

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'early_merge_recovery')!.content)).toMatchObject({
      candidateTreeSha: 'a'.repeat(40),
      prHeadTreeSha: 'b'.repeat(40),
      remoteBaseHead: '9'.repeat(40),
    })
    if (kind === 'corrected') {
      expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES')!.content))
        .toMatchObject({ mergeBase: '9'.repeat(40), candidateCommitSha: correctedCandidateSha })
    } else {
      expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content))
        .toMatchObject({ proofKind: 'already_landed', candidateCommitSha, remoteBaseHead: '9'.repeat(40), remoteBaseTreeSha: 'd'.repeat(40) })
    }
  })

  it('gives a newer open PR precedence over an older merged PR', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const mergedPr = makeMergedPullRequest(42)
    const newerOpenPr = { ...mergedPr, number: 43, state: 'open' as const, headRefOid: 'candidate123', mergeCommitSha: null, mergedAt: null }
    mocks.listPullRequestsForBranch.mockResolvedValue([newerOpenPr, mergedPr])
    queueValidDrafts('newer-open')

    await handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal)

    expect(mocks.reconcileMergedPullRequestCandidate).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).toHaveBeenCalledOnce()
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
  })

  it.each(['equivalent', 'already_landed'] as const)(
    'finds an older merged PR when the newest PR was closed without merging (%s)', async (proofKind) => {
      resetTestDb()
      const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
      const mergedPr = makeMergedPullRequest(42)
      const newerClosedPr = { ...mergedPr, number: 43, state: 'closed' as const, closedAt: '2026-01-02T00:00:00.000Z' }
      mocks.listPullRequestsForBranch.mockResolvedValue([newerClosedPr, mergedPr])
      const proof = {
        ...makeEarlyMergeProof(mergedPr, 'candidate123'),
        candidateTreeSha: '1'.repeat(40),
        mergedHeadTreeSha: proofKind === 'equivalent' ? '1'.repeat(40) : '2'.repeat(40),
      }
      mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce(proofKind === 'equivalent'
        ? { kind: 'equivalent', proof }
        : { kind: 'already_landed', proof, remoteBaseTreeSha: '3'.repeat(40) })

      const sendEvent = vi.fn()
      await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

      expect(mocks.reconcileMergedPullRequestCandidate).toHaveBeenCalledOnce()
      expect(sendEvent).toHaveBeenCalledWith({ type: 'MERGE_COMPLETE' })
      expect(mocks.runOpenCodePrompt).toHaveBeenCalledOnce()
      expect(mocks.runOpenCodePrompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionOwnership: expect.objectContaining({ step: 'candidate_file_audit' }),
      }))
      expect(mocks.pushBranchRef).not.toHaveBeenCalled()
      expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content)).toMatchObject(
        proofKind === 'already_landed'
          ? { proofKind: 'already_landed', candidateTreeSha: '1'.repeat(40), prHeadTreeSha: '2'.repeat(40), remoteBaseTreeSha: '3'.repeat(40) }
          : { proofKind: 'tree_equivalent', candidateTreeSha: '1'.repeat(40), prHeadTreeSha: '1'.repeat(40) },
      )
    },
  )

  it('rechecks merged PR state after pushing before updating its PR record', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const mergedPr = { ...makeMergedPullRequest(), headRefOid: 'candidate123' }
    mocks.listPullRequestsForBranch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mergedPr])
    mocks.reconcileMergedPullRequestCandidate.mockResolvedValueOnce({
      kind: 'equivalent',
      proof: makeEarlyMergeProof(mergedPr, 'candidate123'),
    })
    queueValidDrafts('post-push')

    const sendEvent = vi.fn()
    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.listPullRequestsForBranch).toHaveBeenCalledTimes(3)
    expect(mocks.pushBranchRef).toHaveBeenCalledOnce()
    expect(mocks.createOrUpdateDraftPullRequest).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'MERGE_COMPLETE' })
  })

  it('preserves the recovery receipt when reconciliation fails after the candidate push', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const mergedPr = makeMergedPullRequest(42)
    mocks.listPullRequestsForBranch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mergedPr])
    mocks.reconcileMergedPullRequestCandidate.mockRejectedValueOnce(new EarlyMergeRecoveryManualError({
      reason: 'conflict',
      message: 'Resolve the recovery conflict manually.',
      recoveryWorktreePath: '/tmp/recovery',
      conflictPaths: ['src/example.ts'],
    }))
    queueValidDrafts('recovery-receipt')

    await expect(handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects.toThrow('Resolve the recovery conflict manually.')

    expect(mocks.pushBranchRef).toHaveBeenCalledOnce()
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'CREATING_PULL_REQUEST')!.content))
      .toMatchObject({ step: 'early_merged_pull_request_recovery', prNumber: mergedPr.number })
  })

  it('uses only ticket details and PRD as context while appending reports and diff sections explicitly', async () => {
    resetTestDb()
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Draft concise PR',
      description: 'Explain the implementation without replaying planning context.',
    })

    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml({ ticket_id: ticket.externalId }))
    writeFileSync(`${paths.ticketDir}/prd.yaml`, makePrdYaml({
      ticketId: ticket.externalId,
      problemStatement: 'Use PRD requirements as the reviewer-facing why.',
    }))
    writeFileSync(paths.beadsPath, makeBeadsYaml({ beadCount: 1 }))
    upsertLatestPhaseArtifact(
      ticket.id,
      'final_test_report',
      'RUNNING_FINAL_TEST',
      JSON.stringify({ status: 'passed', summary: 'Final tests passed.' }),
    )

    const { contextParts, finalTestReport } = buildPullRequestContext(
      ticket.id,
      context,
      ticket.description ?? '',
    )
    const prompt = buildPullRequestPrompt({
      fallbackTitle: `${ticket.externalId}: ${ticket.title}`,
      contextParts,
      integrationReport: '{"candidateCommitSha":"abc123"}',
      finalTestReport,
      diffStat: '1 file changed, 2 insertions(+)',
      diffNameStatus: 'M\tsrc/example.ts',
      diffPatch: 'diff --git a/src/example.ts b/src/example.ts',
    })

    expect(contextParts.map((part) => part.source)).toEqual(['ticket_details', 'prd'])
    expect(prompt).toContain('### ticket_details')
    expect(prompt).toContain('### prd')
    expect(prompt).toContain('Use PRD requirements as the reviewer-facing why.')
    expect(prompt).toContain('### integration_report')
    expect(prompt).toContain('### final_test_report')
    expect(prompt).toContain('Final tests passed.')
    expect(prompt).toContain('### final_diff_stat')
    expect(prompt).toContain('### final_diff_name_status')
    expect(prompt).toContain('### final_diff_patch')
    expect(prompt).not.toContain('artifact: interview')
    expect(prompt).not.toContain('beads:')
  })

  it('renders the compact Manual QA outcome without embedding evidence', () => {
    const section = buildManualQaPullRequestSection(JSON.stringify({
      version: 2,
      outcome: 'waived_through',
      createdFixBeadIds: ['QA-v1-1'],
      improvementTicketIds: ['TEST-9'],
      waivedItemIds: ['v2-item-3'],
      evidence: [{ path: '/private/evidence/video.mp4' }],
    }))

    expect(section).toContain('Outcome: waived through')
    expect(section).toContain('Created fix beads: QA-v1-1')
    expect(section).toContain('Created improvement tickets: TEST-9')
    expect(section).toContain('Waived checklist items: v2-item-3')
    expect(section).not.toContain('video.mp4')
  })

  it('renders legacy append-only Manual QA artifact envelopes', () => {
    const section = buildManualQaPullRequestSection(JSON.stringify({
      idempotencyKey: '2:created_fixes',
      value: {
        version: 2,
        outcome: 'created_fixes',
        createdFixBeadIds: ['qa-v2-fix'],
        improvementTicketIds: [],
        waivedItemIds: [],
      },
    }))

    expect(section).toContain('Outcome: created fixes')
    expect(section).toContain('Created fix beads: qa-v2-fix')
  })

  it.each([
    '',
    'not: [valid YAML',
    'version: 1\ncreatedFixBeadIds: [qa-1]',
  ])('omits malformed or incomplete Manual QA summaries from the PR body', (summary) => {
    expect(buildManualQaPullRequestSection(summary)).toBe('')
  })

  it('renders a scalar PR draft section and uses the fallback title', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-scalar-draft' },
      response: validCandidateAuditResponse(),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-scalar-section' },
      response: [
        'title: "  "',
        'summary: A concise summary of the implementation.',
        'why:',
        '  - The ticket requested this behavior.',
        'what_changed:',
        '  - Updated the relevant code path.',
        'validation:',
        '  - Final tests passed.',
        'follow_ups: Add a release note after review.',
      ].join('\n'),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal)

    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      title: `${ticket.externalId}: ${ticket.title}`,
      body: expect.stringContaining('## Follow-ups\n- Add a release note after review.'),
    }))
    expect(mocks.runOpenCodeSessionPrompt).not.toHaveBeenCalled()
  })

  it('does not run a candidate-file audit when the candidate diff is empty', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    mocks.readGitDiff.mockReturnValue({
      stat: '',
      nameStatus: '',
      nameStatusZ: '',
      patch: '',
      patchTruncated: false,
      patchError: null,
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-empty-diff' },
      response: validPullRequestDraftResponse(),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal)

    expect(mocks.runOpenCodePrompt).toHaveBeenCalledOnce()
    expect(mocks.runOpenCodePrompt.mock.calls[0]?.[0].parts[0]?.content).toContain('draft pull request')
    expect(readPullRequestReport(ticket.id)?.candidateFileAudit).toMatchObject({
      status: 'passed',
      includedFiles: [],
      excludedFiles: [],
    })
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
  })

  it('falls back to including every changed file when the candidate audit returns invalid YAML', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-invalid-yaml' },
      response: 'files: [unfinished',
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-after-invalid-audit' },
      response: validPullRequestDraftResponse(),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal)

    expect(readPullRequestReport(ticket.id)?.candidateFileAudit).toMatchObject({
      status: 'fallback',
      includedFiles: ['src/example.ts'],
      excludedFiles: [],
      warnings: [expect.stringContaining('Candidate file audit fell back to including all files')],
    })
    expect(mocks.runOpenCodePrompt).toHaveBeenCalledTimes(2)
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
  })

  it('rejects pull request drafting when the integration report lacks candidate metadata', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'integration_report',
      'INTEGRATING_CHANGES',
      JSON.stringify({ candidateCommitSha: 'candidate123' }),
    )

    await expect(handleCreatePullRequest(
      ticket.id,
      context,
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('Integration report is missing candidate commit metadata.')
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).not.toHaveBeenCalled()
  })

  it('rejects pull request drafting when no main implementer is locked', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket()

    await expect(handleCreatePullRequest(
      ticket.id,
      { ...context, lockedMainImplementer: null },
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('No locked main implementer is configured for pull request drafting.')
    expect(mocks.runOpenCodePrompt).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).not.toHaveBeenCalled()
  })

  it('retries malformed PR drafts before push and PR side effects', async () => {
    resetTestDb()
    const { ticket, context, project, paths } = await createPullRequestReadyTicket({ structuredRetryCount: 1 })
    const sendEvent = vi.fn()
    updateProject(project.id, { councilResponseTimeout: 456_000 })

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-1' },
      response: [
        'files:',
        '  - path:src/example.ts',
        '    decision: include',
        '    reason: Source contains: a colon and remains unchanged.',
      ].join('\n'),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-1' },
      response: 'title: Missing sections',
      messages: [],
    })
    mocks.runOpenCodeSessionPrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-1' },
      response: [
        'title: Reviewer-friendly title',
        'summary:',
        '  - Summarized the implementation.',
        'why:',
        '  - The ticket requested this behavior.',
        'what_changed:',
        '  - Updated the relevant code path.',
        'validation:',
        '  - Final tests passed.',
        'follow_ups: []',
      ].join('\n'),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.runOpenCodePrompt).toHaveBeenCalledTimes(2)
    expect(mocks.runOpenCodeSessionPrompt).toHaveBeenCalledTimes(1)
    expect(mocks.runOpenCodePrompt).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 456_000,
      timeoutKind: 'ai_response',
      sessionOwnership: expect.objectContaining({
        phase: 'CREATING_PULL_REQUEST',
      }),
    }))
    expect(mocks.runOpenCodeSessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 456_000,
      timeoutKind: 'ai_response',
    }))
    expect(mocks.runOpenCodeSessionPrompt.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.pushBranchRef.mock.invocationCallOrder[0]!,
    )
    expect(mocks.pushBranchRef).toHaveBeenCalledTimes(1)
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reviewer-friendly title',
      body: expect.stringContaining('## Summary'),
    }))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'PULL_REQUEST_READY' })

    const report = readPullRequestReport(ticket.id)
    expect(report?.candidateFileAudit?.includedFiles).toEqual(['src/example.ts'])
    expect(report?.candidateFileAudit?.warnings).toEqual(expect.arrayContaining([
      'Repaired YAML mapping keys missing a space after colon before parsing.',
      'Quoted YAML plain scalar values containing colon-space before reparsing.',
    ]))
    expect(readFileSync(paths.executionLogPath, 'utf8')).toContain('Candidate file audit normalization applied repairs')
    expect(report?.structuredOutput?.autoRetryCount).toBe(1)
    expect(report?.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted' }),
    ])
  })

  it('uses fallback PR text after parse retry exhaustion without blocking', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const sendEvent = vi.fn()

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-fallback' },
      response: validCandidateAuditResponse(),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-fallback' },
      response: 'not: enough',
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    expect(mocks.runOpenCodeSessionPrompt).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).toHaveBeenCalledTimes(1)
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      title: `${ticket.externalId}: ${ticket.title}`,
      body: expect.stringContaining('## Summary'),
    }))
    const report = readPullRequestReport(ticket.id)
    expect(report?.structuredOutput?.autoRetryCount).toBe(0)
    expect(report?.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected' }),
    ])
  })

  it('keeps every changed file and proceeds when the candidate-file audit omits a path', async () => {
    resetTestDb()
    const { ticket, context, paths } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })
    const sendEvent = vi.fn()
    const auditSession = { id: 'candidate-audit-incomplete' }
    const auditParts = [{ type: 'text' as const, content: 'Audit changed files against the request.' }]
    const auditResponse = 'files: []'

    mocks.runOpenCodePrompt.mockImplementationOnce(async (options: Parameters<typeof runOpenCodePrompt>[0]) => {
      options.onSessionCreated?.(auditSession)
      options.onStreamEvent?.({
        type: 'text',
        sessionId: auditSession.id,
        text: 'Reviewing the changed source file.',
        streaming: false,
        complete: true,
      })
      options.onPromptDispatched?.({
        session: auditSession,
        parts: auditParts,
        promptText: 'Candidate file audit prompt',
        promptNumber: 1,
        timeoutKind: 'ai_response',
      })
      options.onPromptCompleted?.({
        session: auditSession,
        parts: auditParts,
        response: auditResponse,
        messages: [],
        responseMeta: {} as OpenCodePromptCompletedEvent['responseMeta'],
        attemptMeta: {} as OpenCodePromptCompletedEvent['attemptMeta'],
      })
      return { session: auditSession, response: auditResponse, messages: [] }
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-after-audit-fallback' },
      response: [
        'title: Keep all candidate changes',
        'summary: The PR audit could not classify every file.',
        'why: The ticket still needs review.',
        'what_changed: Kept the changed source file for review.',
        'validation: Final tests passed.',
        'follow_ups: []',
      ].join('\n'),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, sendEvent, new AbortController().signal)

    const report = readPullRequestReport(ticket.id)
    expect(report?.candidateFileAudit).toMatchObject({
      status: 'fallback',
      includedFiles: ['src/example.ts'],
      excludedFiles: [],
      warnings: [expect.stringContaining('Candidate file audit fell back to including all files')],
    })
    const executionLog = readFileSync(paths.executionLogPath, 'utf8')
    expect(executionLog).toContain('Candidate file audit prompt')
    expect(executionLog).toContain('Candidate file audit fell back to including all files')
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledOnce()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'PULL_REQUEST_READY' })
  })

  it('does not continue to git side effects when a draft session stop is unconfirmed', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 0 })

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-before-stop-check' },
      response: validCandidateAuditResponse(),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockImplementationOnce(async (input: {
      onSessionCreated?: (session: { id: string }) => void
    }) => {
      input.onSessionCreated?.({ id: 'pr-draft-paused' })
      throw new Error('draft transport failed')
    })

    await expect(handleCreatePullRequest(
      ticket.id,
      context,
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('Could not confirm abort of pull request draft session pr-draft-paused')
    expect(mocks.pushBranchRef).not.toHaveBeenCalled()
    expect(mocks.createOrUpdateDraftPullRequest).not.toHaveBeenCalled()
  })

  it('does not retry git push side effects after a valid PR draft', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 1 })

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-valid' },
      response: validCandidateAuditResponse(),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-valid' },
      response: [
        'title: Valid PR draft',
        'summary:',
        '  - Summarized the implementation.',
        'why:',
        '  - The ticket requested this behavior.',
        'what_changed:',
        '  - Updated the relevant code path.',
        'validation:',
        '  - Final tests passed.',
        'follow_ups: []',
      ].join('\n'),
      messages: [],
    })
    mocks.pushBranchRef.mockReturnValueOnce({ pushed: false, error: 'remote rejected push' })

    await expect(handleCreatePullRequest(
      ticket.id,
      context,
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('remote rejected push')

    expect(mocks.runOpenCodeSessionPrompt).not.toHaveBeenCalled()
    expect(mocks.pushBranchRef).toHaveBeenCalledTimes(1)
    expect(mocks.createOrUpdateDraftPullRequest).not.toHaveBeenCalled()
    expect(getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'CREATING_PULL_REQUEST')).toBeDefined()
  })

  it('accepts wrapped colon-containing prose in PR draft lists without a retry', async () => {
    resetTestDb()
    const { ticket, context } = await createPullRequestReadyTicket({ structuredRetryCount: 1 })

    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'candidate-audit-wrapped-prose' },
      response: validCandidateAuditResponse(),
      messages: [],
    })
    mocks.runOpenCodePrompt.mockResolvedValueOnce({
      session: { id: 'pr-draft-wrapped-prose' },
      response: [
        'title: Valid wrapped PR draft',
        'summary:',
        '  - `Object.getOwnPropertyDescriptor(fn, key)` reports `writable: false`, and',
        '    `configurable: false`.',
        'why:',
        '  - The ticket requested this behavior.',
        'what_changed:',
        '  - Updated the relevant code path.',
        'validation:',
        '  - Final tests passed.',
        'follow_ups: []',
      ].join('\n'),
      messages: [],
    })

    await handleCreatePullRequest(ticket.id, context, vi.fn(), new AbortController().signal)

    expect(mocks.runOpenCodeSessionPrompt).not.toHaveBeenCalled()
    expect(mocks.createOrUpdateDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('`writable: false`, and `configurable: false`.'),
    }))
  })

  it.each(['app merge', 'external squash', 'external rebase'])('completes %s using its landed SHA without syncing the user checkout', async (method) => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Remote merge verification',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Remote merge verification',
      body: 'Body',
      state: 'open' as const,
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    }
    const merged = {
      ...prInfo,
      state: 'merged',
      mergeCommitSha: `${method}-landed`,
      mergedAt: '2026-01-01T00:05:00.000Z',
    }
    mocks.getPullRequestByNumber.mockReturnValue(method === 'app merge' ? prInfo : merged)
    mocks.mergePullRequest.mockReturnValue(merged)

    await completeMergedPullRequest(buildMergeCompletionInput(
      ticket,
      context,
      prInfo,
      method !== 'app merge',
    ))

    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith(context.externalId, 42)
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(method === 'app merge' ? 1 : 0)
    if (method === 'app merge') {
      expect(mocks.mergePullRequest).toHaveBeenCalledWith(context.externalId, 42, prInfo.title, 'candidate123')
    }
    expect(mocks.verifyRemoteBaseContainsCommit).toHaveBeenCalledWith(context.externalId, 'main', `${method}-landed`)
    expect(mocks.ensureWorktreeClean).not.toHaveBeenCalledWith(context.externalId)
    expect(mocks.tryDeleteRemoteBranch).toHaveBeenCalledWith(
      context.externalId,
      ticket.externalId,
      'candidate123',
    )
    const mergeReport = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
    expect(JSON.parse(mergeReport!.content)).toMatchObject({
      status: 'passed',
      disposition: 'merged',
      localBaseHead: null,
      remoteBaseHead: 'remote-base-sha',
      message: 'Pull request merged into origin/main. Local checkout was not modified.',
    })
    expect(readPullRequestReport(ticket.id)).toMatchObject({
      completedAt: '2026-01-01T00:00:00.000Z',
      prState: 'merged',
      message: 'Pull request merged into origin/main. Local checkout was not modified.',
    })
  })

  it('refreshes the stored PR number when its head branch was deleted or reused', async () => {
    const stored = { number: 42, state: 'merged', headRefName: 'deleted-head' }
    mocks.getPullRequestByNumber.mockResolvedValueOnce(stored)

    expect(await refreshPullRequestState('/repo', 42)).toBe(stored)
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith('/repo', 42)
    await expect(refreshPullRequestState('/repo', null)).rejects.toThrow('recorded pull request number is required')
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledTimes(1)
  })

  it.each(['head mismatch', 'missing candidate', 'merged head mismatch', 'merged base mismatch', 'merged branch mismatch'])('blocks completion for %s', async (failure) => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Candidate mismatch',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Candidate mismatch',
      body: 'Body',
      state: failure.startsWith('merged') ? 'merged' : 'open',
      mergeCommitSha: 'landed123',
      baseRefName: failure === 'merged base mismatch' ? 'wrong-base' : 'main',
      headRefName: failure === 'merged branch mismatch' ? 'wrong-head' : ticket.externalId,
      headRefOid: 'old-sha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    }
    mocks.getPullRequestByNumber.mockReturnValue(prInfo)

    await expect(completeMergedPullRequest({
      ticketId: ticket.id,
      externalId: ticket.externalId,
      projectPath: context.externalId,
      baseBranch: 'main',
      headBranch: ticket.externalId,
      candidateCommitSha: failure === 'missing candidate' ? null : 'candidate123',
      prReport: {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        baseBranch: 'main',
        headBranch: ticket.externalId,
        candidateCommitSha: 'candidate123',
        prNumber: 42,
        prUrl: prInfo.url,
        prState: 'open',
        prHeadSha: 'old-sha',
        title: prInfo.title,
        body: prInfo.body,
        createdAt: prInfo.createdAt,
        updatedAt: prInfo.updatedAt,
        mergedAt: null,
        closedAt: null,
        message: 'Draft PR ready.',
      },
    })).rejects.toThrow(failure === 'missing candidate'
      ? 'has no approved candidate commit SHA'
      : failure === 'merged base mismatch'
        ? 'targets wrong-base, expected main'
        : failure === 'merged branch mismatch'
          ? 'uses head branch wrong-head'
          : 'does not match candidate candidate123')

    expect(mocks.mergePullRequest).not.toHaveBeenCalled()
    expect(mocks.verifyRemoteBaseContainsCommit).not.toHaveBeenCalled()
  })

  it.each([true, false])('rejects unverifiable merged metadata (has landed SHA: %s)', async (hasLandedSha) => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Remote verification failure',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Remote verification failure',
      body: 'Body',
      state: 'merged' as const,
      mergeCommitSha: hasLandedSha ? 'landed123' : null,
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-01T00:05:00.000Z',
      mergedAt: '2026-01-01T00:05:00.000Z',
    }
    mocks.getPullRequestByNumber.mockReturnValue(prInfo)
    const expectedError = hasLandedSha
      ? 'Remote origin/main does not contain commit landed123.'
      : 'Pull request #42 does not expose a merged commit SHA to verify on origin/main.'
    mocks.verifyRemoteBaseContainsCommit.mockImplementation(() => {
      throw new Error('Remote origin/main does not contain commit landed123.')
    })

    await expect(completeMergedPullRequest({
      ticketId: ticket.id,
      externalId: ticket.externalId,
      projectPath: context.externalId,
      baseBranch: 'main',
      headBranch: ticket.externalId,
      candidateCommitSha: 'candidate123',
      prReport: {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        baseBranch: 'main',
        headBranch: ticket.externalId,
        candidateCommitSha: 'candidate123',
        prNumber: 42,
        prUrl: prInfo.url,
        prState: 'merged',
        prHeadSha: 'candidate123',
        title: prInfo.title,
        body: prInfo.body,
        createdAt: prInfo.createdAt,
        updatedAt: prInfo.updatedAt,
        mergedAt: prInfo.mergedAt,
        closedAt: prInfo.closedAt,
        message: 'Draft PR ready.',
      },
      skipRemoteMerge: true,
    })).rejects.toThrow(expectedError)

    expect(mocks.verifyRemoteBaseContainsCommit).toHaveBeenCalledTimes(hasLandedSha ? 1 : 0)
    expect(mocks.mergePullRequest).not.toHaveBeenCalled()
    expect(mocks.tryDeleteRemoteBranch).not.toHaveBeenCalled()
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'verify_remote_merge',
      error: expectedError,
    })
  })

  it('records the merged observation before rejecting an approved-head mismatch', async () => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Persist merged observation',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Persist merged observation',
      body: 'Body',
      state: 'merged' as const,
      mergeCommitSha: 'landed123',
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'unexpected-head',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      closedAt: '2026-01-01T00:05:00.000Z',
      mergedAt: '2026-01-01T00:05:00.000Z',
    }
    mocks.getPullRequestByNumber.mockReturnValue(prInfo)

    await expect(completeMergedPullRequest(buildMergeCompletionInput(
      ticket,
      context,
      prInfo,
      true,
    ))).rejects.toThrow('does not match candidate candidate123')

    expect(readPullRequestReport(ticket.id)).toMatchObject({
      prNumber: 42,
      prState: 'merged',
      prHeadSha: 'unexpected-head',
      mergedAt: prInfo.mergedAt,
      closedAt: prInfo.closedAt,
    })
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'verify_pull_request_candidate',
      prNumber: 42,
      pr: prInfo,
    })
  })

  it('records an initial pull request refresh failure as a durable recovery receipt', async () => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Record refresh failure',
    })
    mocks.getPullRequestByNumber.mockImplementation(() => {
      throw new Error('GitHub unavailable')
    })

    await expect(completeMergedPullRequest({
      ticketId: ticket.id,
      externalId: ticket.externalId,
      projectPath: context.externalId,
      baseBranch: 'main',
      headBranch: ticket.externalId,
      candidateCommitSha: 'candidate123',
      prReport: {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        baseBranch: 'main',
        headBranch: ticket.externalId,
        candidateCommitSha: 'candidate123',
        prNumber: 42,
        prUrl: 'https://github.example/pulls/42',
        prState: 'open',
        prHeadSha: 'candidate123',
        title: 'Record refresh failure',
        body: 'Body',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        mergedAt: null,
        closedAt: null,
        message: 'Draft PR ready.',
      },
    })).rejects.toThrow('GitHub unavailable')

    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'refresh_pull_request',
      error: 'GitHub unavailable',
      prNumber: 42,
      pr: null,
    })
  })

  it('marks a draft PR ready before merging', async () => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Complete a draft pull request',
    })
    const draftPr = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Complete a draft pull request',
      body: 'Body',
      state: 'draft' as const,
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    }
    const readyPr = { ...draftPr, state: 'open' as const }
    const mergedPr = { ...readyPr, state: 'merged' as const, mergeCommitSha: 'landed-from-draft' }
    mocks.getPullRequestByNumber.mockReturnValueOnce(draftPr)
    mocks.markPullRequestReady.mockReturnValueOnce(readyPr)
    mocks.mergePullRequest.mockReturnValueOnce(mergedPr)

    const merged = await completeMergedPullRequest(buildMergeCompletionInput(
      ticket,
      context,
      draftPr,
      false,
    ))

    expect(mocks.markPullRequestReady).toHaveBeenCalledWith(context.externalId, 42)
    expect(mocks.mergePullRequest).toHaveBeenCalledWith(context.externalId, 42, draftPr.title, 'candidate123')
    expect(merged).toMatchObject({ disposition: 'merged', remoteBaseHead: 'remote-base-sha' })
  })

  it('records a recovery receipt when the remote PR remains open after a merge attempt', async () => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Merge remains open',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Merge remains open',
      body: 'Body',
      state: 'open' as const,
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    }
    mocks.getPullRequestByNumber.mockReturnValue(prInfo)
    mocks.mergePullRequest.mockReturnValue(prInfo)

    await expect(completeMergedPullRequest(buildMergeCompletionInput(
      ticket,
      context,
      prInfo,
      false,
    ))).rejects.toThrow('Pull request #42 did not report merged after merge completion; state is open.')

    expect(mocks.mergePullRequest).toHaveBeenCalledOnce()
    expect(mocks.verifyRemoteBaseContainsCommit).not.toHaveBeenCalled()
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'merge_pull_request',
      error: 'Pull request #42 did not report merged after merge completion; state is open.',
      pr: prInfo,
    })
  })

  it('persists a close-unmerged reason when the pull request report is missing or malformed', async () => {
    resetTestDb()
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Finish without merging',
    })
    upsertLatestPhaseArtifact(ticket.id, PULL_REQUEST_REPORT_ARTIFACT, 'CREATING_PULL_REQUEST', '{')
    expect(readPullRequestReport(ticket.id)).toBeNull()
    const closed = completeCloseUnmerged({
      ticketId: ticket.id,
      baseBranch: 'main',
      headBranch: ticket.externalId,
      candidateCommitSha: null,
      prReport: null,
      reason: '  Leave this PR for another review.  ',
    })
    expect(closed).toMatchObject({
      disposition: 'closed_unmerged',
      prNumber: null,
      closeReason: 'Leave this PR for another review.',
    })
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, MERGE_REPORT_ARTIFACT, 'WAITING_PR_REVIEW')!.content))
      .toMatchObject({ disposition: 'closed_unmerged', closeReason: 'Leave this PR for another review.' })
    expect(mocks.tryDeleteRemoteBranch).not.toHaveBeenCalled()
  })
})
