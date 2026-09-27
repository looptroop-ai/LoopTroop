import { describe, expect, it } from 'vitest'
import { TEST } from '@/test/factories'
import type { TicketArtifact } from '@/hooks/useTicketArtifacts'
import {
  buildFinalInterviewArtifactContent,
  buildInterviewDiffEntries,
  buildRefinementDiffEntries,
  extractCanonicalInterviewDetail,
  extractCompiledInterviewDetail,
  extractDraftDetail,
  getArtifactSourcePhases,
  getArtifactTargetPhases,
  normalizeInterviewDiffQuestions,
  normalizeRawAttempts,
  parseCleanupReport,
  parseCoverageArtifact,
  parseExecutionSetupPlanReport,
  parseExecutionSetupProfile,
  parseExecutionSetupRuntimeReport,
  parseIntegrationReport,
  parsePullRequestReport,
  resolveStaticArtifact,
  shouldCollapseVotingMemberArtifacts,
} from '../phaseArtifactTypes'

function makeArtifact(artifactType: string, phase: string): TicketArtifact {
  return {
    id: 1,
    ticketId: TEST.ticketId,
    phase,
    phaseAttempt: 1,
    artifactType,
    filePath: null,
    content: 'artifact content',
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
  }
}

describe('phaseArtifactTypes', () => {
  it('keeps generated setup candidates separate from approval copies', () => {
    expect(getArtifactTargetPhases('GENERATING_EXECUTION_SETUP_PLAN')).toEqual(['GENERATING_EXECUTION_SETUP_PLAN'])
    expect(getArtifactTargetPhases('WAITING_EXECUTION_SETUP_APPROVAL')).toEqual(['WAITING_EXECUTION_SETUP_APPROVAL'])
  })

  it('resolves Manual QA preparation to the checklist rather than a later coverage artifact', () => {
    const checklist = {
      id: 1,
      ticketId: TEST.ticketId,
      phase: 'GENERATING_QA_CHECKLIST',
      phaseAttempt: 1,
      artifactType: 'manual_qa_checklist',
      filePath: null,
      content: '{"version":1,"checklist":"summary: Verify checkout"}',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }
    const coverage = { ...checklist, id: 2, artifactType: 'manual_qa_coverage', content: '{"coveredCount":1}' }

    expect(resolveStaticArtifact(
      { id: 'manual-qa-checklist', label: 'Manual QA Checklist', description: 'Generated checks', icon: null },
      'GENERATING_QA_CHECKLIST',
      [coverage, checklist],
    )).toBe(checklist)
  })

  it('drops persisted interview ui diff entries when before and after text are trim-identical', () => {
    const interviewDocument = JSON.stringify({
      questions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          question: 'Should the theme switcher keep the same layout?',
        },
      ],
    })

    const entries = buildInterviewDiffEntries(JSON.stringify({
      originalContent: interviewDocument,
      refinedContent: interviewDocument,
      uiRefinementDiff: {
        domain: 'interview',
        winnerId: 'openai/gpt-5.4',
        generatedAt: '2026-04-06T11:38:37.016Z',
        entries: [
          {
            key: 'Q01:modified:0',
            changeType: 'modified',
            itemKind: 'question',
            label: 'Q01',
            beforeId: 'Q01',
            afterId: 'Q01',
            beforeText: 'Should the theme switcher keep the same layout?',
            afterText: '  Should the theme switcher keep the same layout?  ',
            attributionStatus: 'model_unattributed',
          },
        ],
      },
    }))

    expect(entries).toEqual([])
  })

  it('falls back to structural PRD coverage diffs when saved coverage diff metadata is empty', () => {
    const beforePrd = [
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: prd',
      'status: draft',
      'source_interview:',
      '  content_sha256: approved-hash',
      'product:',
      '  problem_statement: Keep PRD coverage diffs visible.',
      '  target_users:',
      '    - LoopTroop maintainers',
      'scope:',
      '  in_scope:',
      '    - Coverage diff fallback',
      '  out_of_scope:',
      '    - Execution changes',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - Prefer validated metadata when it exists.',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints:',
      '    - Coverage revisions must remain reviewable.',
      '  error_handling_rules:',
      '    - Fall back to structural before/after diffs when saved change metadata is unusable.',
      '  tooling_assumptions:',
      '    - Use vitest.',
      'epics:',
      `  - id: ${TEST.epicId}`,
      '    title: Review PRD coverage revisions',
      '    objective: Keep approval diffs visible.',
      '    implementation_steps:',
      '      - Preserve fallback diffs.',
      '    user_stories:',
      `      - id: ${TEST.storyId}`,
      '        title: Inspect the saved coverage diff',
      '        acceptance_criteria:',
      '          - Approval shows a meaningful coverage diff.',
      '        implementation_steps:',
      '          - Show a structural diff when saved metadata is empty.',
      '        verification:',
      '          required_commands:',
      '            - npm run test',
      'risks: []',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n')
    const afterPrd = beforePrd.replace(
      '    - Use vitest.',
      [
        '    - Use vitest.',
        '    - Build a structural fallback diff when saved coverage diff metadata is empty.',
      ].join('\n'),
    )

    const entries = buildRefinementDiffEntries(JSON.stringify({
      winnerId: 'openai/gpt-5.4',
      coverageBaselineContent: beforePrd,
      coverageBaselineVersion: 2,
      refinedContent: afterPrd,
      coverageUiRefinementDiff: {
        domain: 'prd',
        winnerId: 'openai/gpt-5.4',
        generatedAt: '2026-04-10T09:35:04.430Z',
        entries: [],
      },
    }), 'prd')

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeType: 'modified',
        itemKind: 'technical_requirements.tooling_assumptions',
        label: 'Tooling Assumptions',
      }),
    ]))
  })

  it('summarizes draft and interview artifacts across legacy and structured formats', () => {
    expect(extractDraftDetail(null)).toBe('')
    expect(extractDraftDetail('- id: bead-1\n  title: Verify checkout')).toBe('1 beads')
    expect(extractDraftDetail('Proposed 3 questions')).toBe('proposed 3 questions')
    expect(extractDraftDetail('Quality score: 8.5/10')).toBe('scored 8.5/10')
    expect(extractDraftDetail('First line\n\nSecond line')).toBe('2 lines')
    expect(extractDraftDetail(' \n  ')).toBe('')

    expect(extractCompiledInterviewDetail(JSON.stringify({ questionCount: 1 }))).toBe('1 question')
    expect(extractCompiledInterviewDetail(JSON.stringify({ questions: [{}, {}] }))).toBe('2 questions')
    expect(extractCompiledInterviewDetail('{invalid')).toBe('')

    const canonicalInterview = JSON.stringify({ artifact: 'interview', questions: [{ question: 'First?' }, { question: 'Second?' }] })
    expect(extractCanonicalInterviewDetail(canonicalInterview)).toBe('2 questions')
    expect(extractCanonicalInterviewDetail(JSON.stringify({ interview: canonicalInterview }))).toBe('2 questions')
    expect(extractCanonicalInterviewDetail(JSON.stringify({ artifact: 'prd', questions: [] }))).toBe('')
    expect(normalizeInterviewDiffQuestions(JSON.stringify({ questions: [
      { id: 'Q7', phase: 'Structure', question: '  Keep the saved ID?  ' },
      { question: 'Assign a fallback ID?' },
    ] }))).toEqual([
      { id: 'Q07', phase: 'Structure', question: 'Keep the saved ID?' },
      { id: 'Q02', phase: undefined, question: 'Assign a fallback ID?' },
    ])
  })

  it('normalizes retry histories and common report payloads', () => {
    expect(normalizeRawAttempts(null)).toBeUndefined()
    expect(normalizeRawAttempts([null, {}, { attempt_number: 3, bead_iteration: 2, name: ' retry ', outcome: 'failed', step: 'review', initial_input: ' prompt ', model_output: ' output ', model: 'model-a', session_id: 'session-3' }])).toEqual([
      expect.objectContaining({
        attempt: 3,
        iteration: 2,
        label: 'retry',
        status: 'failed',
        outcome: 'failed',
        stage: 'review',
        initialInput: 'prompt',
        modelOutput: 'output',
        modelId: 'model-a',
        sessionId: 'session-3',
      }),
    ])
    expect(normalizeRawAttempts([{}, null])).toBeUndefined()

    expect(parseIntegrationReport('{invalid')).toBeNull()
    expect(parseIntegrationReport(JSON.stringify({ status: ' pushed ', commitCount: null, pushError: ' ' }))).toEqual({
      status: 'pushed',
      completedAt: undefined,
      baseBranch: undefined,
      preSquashHead: undefined,
      candidateCommitSha: undefined,
      mergeBase: undefined,
      commitCount: null,
      pushed: undefined,
      pushDeferred: undefined,
      pushError: null,
      message: undefined,
    })

    expect(parseCleanupReport(JSON.stringify({ removedFiles: ['a.tmp', '', 2], errors: ['permission denied'] }))).toEqual({
      status: 'warning',
      removedDirs: [],
      removedFiles: ['a.tmp'],
      preservedPaths: [],
      errors: ['permission denied'],
    })
    expect(parseCleanupReport(JSON.stringify({ status: 'clean', removedDirs: ['tmp'] }))?.status).toBe('clean')
    expect(parseCleanupReport(JSON.stringify({ unrelated: true }))).toBeNull()

    expect(parseExecutionSetupPlanReport(JSON.stringify({ ready: true, errors: [], notes: ['reviewed'], raw_attempts: [{ error: 'first try failed' }] }))).toEqual(expect.objectContaining({
      ready: true,
      errors: [],
      notes: ['reviewed'],
      rawAttempts: [expect.objectContaining({ error: 'first try failed' })],
    }))
    expect(parseExecutionSetupPlanReport(JSON.stringify({ unrelated: true }))).toBeNull()
  })

  it('normalizes candidate file audit decisions, reasons, aliases, and duplicate paths', () => {
    const report = parsePullRequestReport(JSON.stringify({
      status: 'open',
      candidateFileAudit: {
        audited_at: '2026-06-01T12:00:00.000Z',
        candidate_commit_sha: null,
        included_files: [' src/app.ts ', { file_path: 'src/lib.ts' }, 'src/app.ts'],
        excluded_files: ['.env'],
        ignored_files: [{ file: 'dist/bundle.js' }],
        reviewed_files: ['README.md'],
        ignored_reasons: { '.env': 'Contains local secrets.', 'dist/bundle.js': 'Generated output.' },
        entries: [
          { path: 'src/app.ts', decision: 'included', reason: 'Already captured by the top-level list.' },
          { path: 'src/config.ts', intent: 'reviewed' },
          { filePath: '   ' },
        ],
        stats: { total_files: 5, included_files: 2, excluded_files: 1, reviewed_files: 1 },
      },
    }))

    expect(report?.status).toBe('open')
    expect(report?.candidateFileAudit).toEqual(expect.objectContaining({
      auditedAt: '2026-06-01T12:00:00.000Z',
      candidateCommitSha: null,
      includedFiles: ['src/app.ts', 'src/lib.ts'],
      excludedFiles: ['.env', 'dist/bundle.js'],
      ignoredFiles: ['dist/bundle.js'],
      reviewedFiles: ['README.md', 'src/config.ts'],
      entries: expect.arrayContaining([
        { path: 'src/app.ts', decision: 'included', reason: 'Already captured by the top-level list.' },
        { path: '.env', decision: 'exclude', reason: 'Contains local secrets.' },
        { path: 'dist/bundle.js', decision: 'ignored', reason: 'Generated output.' },
        { path: 'src/config.ts', decision: 'reviewed' },
      ]),
      stats: { totalFiles: 5, includedFiles: 2, excludedFiles: 1, reviewedFiles: 1 },
    }))
    expect(parsePullRequestReport(JSON.stringify({ unrelated: true }))).toBeNull()
  })

  it('parses execution setup profiles and runtime receipts from canonical aliases', () => {
    const profile = {
      artifact: 'execution_setup_profile',
      schema_version: 1,
      ticket_id: TEST.ticketId,
      temp_roots: ['.cache/tooling'],
      bootstrap_commands: ['npm ci'],
      verification_commands: ['npm test'],
      workspace_inputs: [
        { path: 'config/local.json', kind: 'file', source_status: 'untracked', category: 'local_config', allow_large_copy: true, reason: 'Local endpoints.' },
        { path: 'fixtures/data', kind: 'directory', category: 'unknown-category' },
        null,
      ],
      workspace_probes: [{ id: 'probe-1', command: 'npm test', purpose: 'Check workspace' }, null],
      workspace_probe_receipts: [
        { id: 'probe-1', command: 'npm test', status: 'failed', exit_code: 1, duration_ms: 25, output_excerpt: 'failed' },
        { id: 'probe-2', status: 'timed_out' },
        { id: 'probe-3', status: 'skipped' },
        { id: 'probe-4', status: 'unexpected', exit_code: 'bad' },
      ],
      git_hooks: {
        policy: 'use_native_hooks',
        detected: [
          { name: 'pre-commit', path: '.git/hooks/pre-commit', source: 'git', runnable: 'yes', manager_hint: 'native' },
          { name: 'commit-msg', kind: 'manager_config', runnable: 'maybe' },
        ],
        validation_commands: [{ id: 'validate', hook: 'pre-commit', command: 'npm test', purpose: 'Validate' }],
        validation_receipts: [{ id: 'validate', status: 'passed' }],
      },
      reusable_artifacts: [{ path: 'node_modules', type: 'dependency_cache', reason: 'Avoid reinstalling' }, { path: '', kind: '', purpose: '' }],
      project_commands: { prepare: ['npm ci'], test_full: ['npm test'], lint_full: ['npm run lint'], typecheck_full: ['npm run typecheck'] },
      quality_gate_policy: { tests: 'required', lint: 'required', typecheck: 'required', full_project_fallback: 'npm run verify' },
      cautions: ['Inspect the local configuration.'],
    }

    expect(parseExecutionSetupProfile(JSON.stringify({ status: 'empty' }))).toBeNull()
    const parsedProfile = parseExecutionSetupProfile(JSON.stringify(profile))
    expect(parsedProfile).toEqual(expect.objectContaining({
      schemaVersion: 1,
      ticketId: TEST.ticketId,
      toolingProbeCommands: ['npm test'],
      workspaceInputs: [
        expect.objectContaining({ category: 'local_config', sourceStatus: 'untracked', allowLargeCopy: true }),
        expect.objectContaining({ category: 'other_non_reproducible', kind: 'directory', sourceStatus: 'ignored' }),
      ],
      workspaceProbeReceipts: [
        expect.objectContaining({ status: 'failed', exitCode: 1, durationMs: 25, outputExcerpt: 'failed' }),
        expect.objectContaining({ status: 'timed_out', exitCode: null }),
        expect.objectContaining({ status: 'skipped' }),
        expect.objectContaining({ status: 'passed', exitCode: null }),
      ],
      gitHooks: expect.objectContaining({
        policy: 'use_native_hooks',
        detected: [
          expect.objectContaining({ kind: 'hook', runnable: 'yes', managerHint: 'native' }),
          expect.objectContaining({ kind: 'manager_config', runnable: 'unknown' }),
        ],
      }),
      reusableArtifacts: [{ path: 'node_modules', kind: 'dependency_cache', purpose: 'Avoid reinstalling' }],
      projectCommands: expect.objectContaining({ testFull: ['npm test'], lintFull: ['npm run lint'] }),
      qualityGatePolicy: expect.objectContaining({ fullProjectFallback: 'npm run verify' }),
      cautions: ['Inspect the local configuration.'],
    }))

    expect(parseExecutionSetupRuntimeReport(JSON.stringify({}))).toBeNull()
    const runtime = parseExecutionSetupRuntimeReport(JSON.stringify({
      ready: false,
      checked_at: '2026-06-01T12:00:00.000Z',
      profile,
      checks: { workspace: 'ready', temp_scope: 'clean' },
      attempt_history: [{}, { attempt: 2, status: 'failed', failure_reason: 'Probe failed', note_appended: 'Retry safely.' }],
      max_iterations: null,
      retry_notes: ['Retry the failed probe.'],
      execution_added_commands: ['npm run lint'],
    }))
    expect(runtime).toEqual(expect.objectContaining({
      ready: false,
      checkedAt: '2026-06-01T12:00:00.000Z',
      checks: { workspace: 'ready', tooling: '', tempScope: 'clean', policy: '' },
      attemptHistory: [
        expect.objectContaining({ attempt: 1, status: 'unknown' }),
        expect.objectContaining({ attempt: 2, failureReason: 'Probe failed', noteAppended: 'Retry safely.' }),
      ],
      maxIterations: null,
      retryNotes: ['Retry the failed probe.'],
      executionAddedCommands: ['npm run lint'],
    }))
  })

  it('maps every static artifact family to its expected phase and type', () => {
    const cases: Array<[string, string, string]> = [
      ['winner-draft', 'COUNCIL_VOTING_INTERVIEW', 'interview_votes'],
      ['vote-details', 'COUNCIL_VOTING_INTERVIEW', 'interview_votes'],
      ['vote-details', 'COUNCIL_VOTING_PRD', 'prd_votes'],
      ['vote-details', 'COUNCIL_VOTING_BEADS', 'beads_votes'],
      ['final-interview', 'WAITING_INTERVIEW_APPROVAL', 'interview_coverage_input'],
      ['final-interview', 'COMPILING_INTERVIEW', 'interview_compiled'],
      ['winner-prd-draft', 'COUNCIL_VOTING_PRD', 'prd_votes'],
      ['winner-beads-draft', 'COUNCIL_VOTING_BEADS', 'beads_votes'],
      ['interview-answers', 'VERIFYING_INTERVIEW_COVERAGE', 'interview_coverage_input'],
      ['interview-answers', 'WAITING_INTERVIEW_ANSWERS', 'interview_session'],
      ['refined-prd', 'WAITING_PRD_APPROVAL', 'prd_coverage_revision'],
      ['refined-prd', 'WAITING_PRD_APPROVAL', 'prd_coverage_input'],
      ['refined-prd', 'WAITING_PRD_APPROVAL', 'prd_refined'],
      ['final-prd-draft', 'WAITING_PRD_APPROVAL', 'prd_refined'],
      ['coverage-report', 'WAITING_PRD_APPROVAL', 'prd_coverage'],
      ['coverage-report', 'WAITING_PRD_APPROVAL', 'prd_coverage_revision'],
      ['coverage-report', 'WAITING_BEADS_APPROVAL', 'beads_coverage'],
      ['coverage-report', 'WAITING_BEADS_APPROVAL', 'beads_coverage_revision'],
      ['refined-beads', 'WAITING_BEADS_APPROVAL', 'beads_coverage_revision'],
      ['refined-beads', 'WAITING_BEADS_APPROVAL', 'beads_coverage_input'],
      ['refined-beads', 'WAITING_BEADS_APPROVAL', 'beads_expanded'],
      ['refined-beads', 'WAITING_BEADS_APPROVAL', 'beads_refined'],
      ['final-beads-draft', 'EXPANDING_BEADS', 'beads_expanded'],
      ['final-beads-draft', 'EXPANDING_BEADS', 'beads_refined'],
      ['relevant-files-scan', 'WAITING_PR_REVIEW', 'relevant_files_scan'],
      ['diagnostics', 'WAITING_PR_REVIEW', 'preflight_report'],
      ['execution-setup-plan', 'WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_plan'],
      ['execution-setup-plan-report', 'WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_plan_report'],
      ['execution-setup-runtime', 'WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_report'],
      ['execution-setup-profile', 'WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_profile'],
      ['execution-setup-report', 'WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_report'],
      ['bead-commits', 'WAITING_PR_REVIEW', 'bead_diff:bead-1'],
      ['test-results', 'WAITING_PR_REVIEW', 'final_test_report'],
      ['manual-qa-checklist', 'WAITING_PR_REVIEW', 'manual_qa_checklist'],
      ['commit-summary', 'WAITING_PR_REVIEW', 'integration_report'],
      ['pull-request-report', 'WAITING_PR_REVIEW', 'pull_request_report'],
      ['cleanup-report', 'WAITING_PR_REVIEW', 'cleanup_report'],
    ]

    for (const [definitionId, phase, artifactType] of cases) {
      const artifact = makeArtifact(artifactType, getArtifactTargetPhases(phase)[0]!)
      expect(resolveStaticArtifact(
        { id: definitionId, label: definitionId, description: '', icon: null },
        phase,
        [artifact],
      ), `${definitionId} in ${phase}`).toBe(artifact)
    }

    const samePhaseFallback = makeArtifact('unknown_custom_report', 'WAITING_PR_REVIEW')
    const contentFallback = makeArtifact('unrelated', 'WAITING_PR_REVIEW')
    expect(resolveStaticArtifact({ id: 'custom-report', label: '', description: '', icon: null }, 'WAITING_PR_REVIEW', [samePhaseFallback])).toBe(samePhaseFallback)
    expect(resolveStaticArtifact({ id: 'unmapped-artifact', label: '', description: '', icon: null }, 'WAITING_PR_REVIEW', [contentFallback])).toBe(contentFallback)
    expect(resolveStaticArtifact({ id: 'unmapped-artifact', label: '', description: '', icon: null }, 'WAITING_PR_REVIEW', [])).toBeUndefined()

    expect(getArtifactSourcePhases('COMPILING_INTERVIEW')).toEqual(['COMPILING_INTERVIEW', 'COUNCIL_DELIBERATING', 'COUNCIL_VOTING_INTERVIEW'])
    expect(getArtifactSourcePhases('WAITING_EXECUTION_SETUP_APPROVAL')).toEqual(['WAITING_EXECUTION_SETUP_APPROVAL'])
    expect(shouldCollapseVotingMemberArtifacts('COUNCIL_VOTING_PRD')).toBe(true)
    expect(shouldCollapseVotingMemberArtifacts('WAITING_PRD_APPROVAL')).toBe(false)
  })

  it('parses coverage attempts and transitions while discarding malformed entries', () => {
    expect(parseCoverageArtifact('{invalid')).toBeNull()
    expect(parseCoverageArtifact(JSON.stringify({ unrelated: true }))).toBeNull()
    const coverage = parseCoverageArtifact(JSON.stringify({
      status: 'gaps',
      hasGaps: true,
      finalCandidateVersion: 3,
      parsed: {
        status: 'gaps',
        gaps: ['Missing a recovery check.', '  ', 5],
        follow_up_questions: [{ id: 'Q2', prompt: 'How does retry work?', phase: 'Recovery', priority: 'high' }, null, { prompt: '  ' }],
      },
      attempts: [
        { candidateVersion: 2, status: 'gaps', summary: 'Needs another pass.', gaps: ['Add recovery.'], terminationReason: 'pass_limit', source: 'coverage' },
        { candidateVersion: 0, status: 'clean', summary: 'Invalid candidate.' },
        null,
      ],
      transitions: [
        {
          fromVersion: 1,
          toVersion: 2,
          summary: 'Added the retry requirement.',
          fromContent: 'before',
          toContent: 'after',
          gap_resolutions: [{
            gap: 'No recovery path',
            action: 'updated_prd',
            rationale: 'Added retry behavior.',
            affected_items: [{ item_type: 'user_story', id: 'US-A1', label: 'Retry checkout' }, null],
          }],
          resolutionNotes: ['Recheck the new criterion.'],
          source: 'coverage',
        },
        { fromVersion: 2, toVersion: 3, summary: 'Invalid transition.' },
        null,
      ],
      hasRemainingGaps: true,
      remainingGaps: ['Add negative retry coverage.', ' '],
      latestExtraFixSummary: null,
    }))

    expect(coverage).toEqual(expect.objectContaining({
      status: 'gaps',
      hasGaps: true,
      finalCandidateVersion: 3,
      parsed: expect.objectContaining({
        followUpQuestions: [],
        follow_up_questions: [{ id: 'Q2', question: 'How does retry work?', phase: 'Recovery', priority: 'high', rationale: undefined }],
      }),
      attempts: [expect.objectContaining({ candidateVersion: 2, status: 'gaps', source: 'coverage', terminationReason: 'pass_limit' })],
      transitions: [expect.objectContaining({
        fromVersion: 1,
        toVersion: 2,
        gapResolutions: [{
          gap: 'No recovery path',
          action: 'updated_prd',
          rationale: 'Added retry behavior.',
          affectedItems: [{ itemType: 'user_story', id: 'US-A1', label: 'Retry checkout' }],
        }],
        resolutionNotes: ['Recheck the new criterion.'],
      })],
      hasRemainingGaps: true,
      remainingGaps: ['Add negative retry coverage.'],
      latestExtraFixSummary: null,
    }))
  })

  it('normalizes legacy interview and refinement diffs without showing no-op entries', () => {
    const interviewDiff = buildInterviewDiffEntries(JSON.stringify({
      changes: [
        { type: 'modified', before: { id: 'Q1', phase: 'Foundation', question: 'Old wording' }, after: { id: 'Q1', phase: 'Structure', question: 'New wording' } },
        { type: 'added', after: { question: 'A question without an id?' } },
        { type: 'modified', before: { id: 'Q3', question: 'Same wording' }, after: { id: 'Q3', question: ' Same wording ' } },
        { type: 'unknown', before: { id: 'Q4', question: 'Ignored' }, after: { id: 'Q4', question: 'Ignored too' } },
        { type: 'replaced', before: { id: 'Q5', question: 'Old prompt' }, after: { id: 'Q5', question: 'Replacement prompt' }, inspiration: { memberId: 'alternative-a', question: { id: 'Q9', phase: 'Assembly', question: 'Suggested prompt' } } },
      ],
      structuredOutput: { repairWarnings: ['Synthesized omitted interview refinement modified change for Q1'] },
    }))
    expect(interviewDiff).toEqual([
      expect.objectContaining({ id: 'Q1', phase: 'Structure', before: 'Old wording', after: 'New wording', attributionStatus: 'synthesized_unattributed' }),
      expect.objectContaining({ id: 'Q02', after: 'A question without an id?' }),
      expect.objectContaining({ id: 'Q5', changeType: 'replaced', attributionStatus: 'inspired', inspiration: expect.objectContaining({ question: 'Suggested prompt', phase: 'Assembly' }) }),
    ])
    expect(buildInterviewDiffEntries('{invalid')).toEqual([])

    const finalInterview = buildFinalInterviewArtifactContent(null, JSON.stringify({ refinedContent: 'questions:\n  - id: Q1\n    phase: Foundation\n    question: Verify checkout' }))
    expect(JSON.parse(finalInterview ?? 'null')).toEqual(expect.objectContaining({
      refinedContent: expect.stringContaining('Verify checkout'),
      questionCount: 1,
      refinedQuestionCount: 1,
    }))
    expect(buildFinalInterviewArtifactContent(null, '{invalid')).toBeNull()

    const refinementDiff = buildRefinementDiffEntries(JSON.stringify({ refinedContent: 'new PRD content', changes: [
      { type: 'modified', itemType: 'user_story', before: { id: 'US-1', label: 'Old title' }, after: { id: 'US-1', label: 'New title' }, inspiration: { alternative_draft: 'member-b', item: { id: 'US-2', label: 'Suggested title', detail: 'A better title' } } },
      { type: 'removed', before: { id: 'US-3', label: 'Removed title' }, inspiration: null },
      { type: 'unknown', after: { id: 'US-4', label: 'Ignored' } },
    ] }), 'prd')
    expect(refinementDiff).toEqual([
      expect.objectContaining({ changeType: 'modified', itemKind: 'user_story', attributionStatus: 'inspired', inspiration: expect.objectContaining({ memberId: 'member-b', sourceId: 'US-2', sourceText: 'A better title' }) }),
      expect.objectContaining({ changeType: 'removed', beforeText: 'Removed title', inspiration: null }),
    ])
  })
})
