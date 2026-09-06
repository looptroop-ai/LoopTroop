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
import {
  buildPullRequestContext,
  buildManualQaPullRequestSection,
  buildPullRequestPrompt,
  completeMergedPullRequest,
  handleCreatePullRequest,
  readPullRequestReport,
} from '../phases/pullRequestPhase'

const mocks = vi.hoisted(() => ({
  runOpenCodePrompt: vi.fn(),
  runOpenCodeSessionPrompt: vi.fn(),
  pushBranchRef: vi.fn(),
  readGitDiff: vi.fn(),
  createOrUpdateDraftPullRequest: vi.fn(),
  captureGitRecoveryReceipt: vi.fn((input: unknown) => input),
  getPullRequestForBranch: vi.fn(),
  ensureWorktreeClean: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
  tryDeleteRemoteBranch: vi.fn(),
  verifyRemoteBaseContainsCommit: vi.fn(),
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
  getPullRequestForBranch: mocks.getPullRequestForBranch,
  ensureWorktreeClean: mocks.ensureWorktreeClean,
  markPullRequestReady: mocks.markPullRequestReady,
  mergePullRequest: mocks.mergePullRequest,
  tryDeleteRemoteBranch: mocks.tryDeleteRemoteBranch,
  verifyRemoteBaseContainsCommit: mocks.verifyRemoteBaseContainsCommit,
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

  function validCandidateAuditResponse(path = 'src/example.ts') {
    return [
      'files:',
      `  - path: ${path}`,
      '    decision: include',
      '    reason: Source change belongs in the requested PR.',
    ].join('\n')
  }

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

  it('completes a merged PR by verifying the remote base without syncing the user checkout', async () => {
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
    mocks.getPullRequestForBranch.mockReturnValue(prInfo)
    mocks.mergePullRequest.mockReturnValue({
      ...prInfo,
      state: 'merged',
      mergedAt: '2026-01-01T00:05:00.000Z',
    })

    await completeMergedPullRequest({
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
    })

    expect(mocks.mergePullRequest).toHaveBeenCalledOnce()
    expect(mocks.verifyRemoteBaseContainsCommit).toHaveBeenCalledWith(context.externalId, 'main', 'candidate123')
    expect(mocks.ensureWorktreeClean).not.toHaveBeenCalledWith(context.externalId)
    expect(mocks.tryDeleteRemoteBranch).toHaveBeenCalledWith(context.externalId, ticket.externalId)
    const mergeReport = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
    expect(JSON.parse(mergeReport!.content)).toMatchObject({
      status: 'passed',
      disposition: 'merged',
      localBaseHead: null,
      remoteBaseHead: 'remote-base-sha',
      message: 'Pull request merged into origin/main. Local checkout was not modified.',
    })
    expect(readPullRequestReport(ticket.id)).toMatchObject({
      prState: 'merged',
      message: 'Pull request merged into origin/main. Local checkout was not modified.',
    })
  })

  it('blocks before merge when the pull request head does not match the candidate commit', async () => {
    resetTestDb()
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Candidate mismatch',
    })
    const prInfo = {
      number: 42,
      url: 'https://github.example/pulls/42',
      title: 'Candidate mismatch',
      body: 'Body',
      state: 'open' as const,
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'old-sha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      mergedAt: null,
    }
    mocks.getPullRequestForBranch.mockReturnValue(prInfo)

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
    })).rejects.toThrow('does not match candidate candidate123')

    expect(mocks.mergePullRequest).not.toHaveBeenCalled()
    expect(mocks.verifyRemoteBaseContainsCommit).not.toHaveBeenCalled()
  })

  it('fails after merge if the remote base does not contain the candidate commit', async () => {
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
      baseRefName: 'main',
      headRefName: ticket.externalId,
      headRefOid: 'candidate123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-01T00:05:00.000Z',
      mergedAt: '2026-01-01T00:05:00.000Z',
    }
    mocks.getPullRequestForBranch.mockReturnValue(prInfo)
    mocks.verifyRemoteBaseContainsCommit.mockImplementation(() => {
      throw new Error('Remote origin/main does not contain commit candidate123.')
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
    })).rejects.toThrow('Remote origin/main does not contain commit candidate123')

    expect(mocks.mergePullRequest).not.toHaveBeenCalled()
    expect(mocks.tryDeleteRemoteBranch).not.toHaveBeenCalled()
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'verify_remote_merge',
      error: 'Remote origin/main does not contain commit candidate123.',
    })
  })
})
