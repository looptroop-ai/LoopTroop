import { describe, expect, it } from 'vitest'
import { WORKFLOW_PHASES, WORKFLOW_PHASE_IDS, getAvailableWorkflowActions } from '@shared/workflowMeta'
import { getCascadeEditWarningMessage, getStatusDescription, getStatusUserLabel } from '@/lib/workflowMeta'

describe.concurrent('status text lookups', () => {
  it('has a description and a label for every workflow phase', () => {
    // The lookups are built from the phase table and keyed by it, so a phase
    // without text cannot compile. This checks the other half: that the text is
    // actually present rather than an empty string.
    for (const id of WORKFLOW_PHASE_IDS) {
      expect(getStatusDescription(id), id).toBeTruthy()
      expect(getStatusUserLabel(id), id).toBeTruthy()
    }
  })

  it('has no description for a status that is not part of the workflow', () => {
    expect(getStatusDescription('NOT_A_STATUS')).toBeUndefined()
    expect(getStatusDescription('')).toBeUndefined()
    // A plain object's inherited members are not statuses either.
    expect(getStatusDescription('toString')).toBeUndefined()
  })

  it('falls back to a readable label for an unrecognised status', () => {
    expect(getStatusUserLabel('SOME_FUTURE_STATUS')).toBe('SOME FUTURE STATUS')
  })
})

describe.concurrent('getCascadeEditWarningMessage', () => {
  it('does not warn when editing interview before PRD has started', () => {
    expect(getCascadeEditWarningMessage('WAITING_INTERVIEW_APPROVAL', 'interview')).toBeNull()
  })

  it('warns about PRD when editing interview while PRD is being drafted', () => {
    expect(getCascadeEditWarningMessage('DRAFTING_PRD', 'interview')).toBe(
      'Saving this Interview edit will restart PRD/specs planning from the edited Interview. Previous PRD versions will be archived and remain available read-only.',
    )
  })

  it('warns about PRD when editing interview at PRD approval', () => {
    expect(getCascadeEditWarningMessage('WAITING_PRD_APPROVAL', 'interview')).toBe(
      'Saving this Interview edit will restart PRD/specs planning from the edited Interview. Previous PRD versions will be archived and remain available read-only.',
    )
  })

  it('warns about PRD and Beads when editing interview at Beads approval', () => {
    expect(getCascadeEditWarningMessage('WAITING_BEADS_APPROVAL', 'interview')).toBe(
      'Saving this Interview edit will restart PRD/specs planning and Beads planning from the edited Interview. Previous PRD and Beads versions will be archived and remain available read-only.',
    )
  })

  it('does not warn when editing interview during execution phases', () => {
    expect(getCascadeEditWarningMessage('PRE_FLIGHT_CHECK', 'interview')).toBeNull()
  })

  it('does not warn when editing PRD before Beads has been approved', () => {
    expect(getCascadeEditWarningMessage('WAITING_PRD_APPROVAL', 'prd')).toBeNull()
  })

  it('warns when editing PRD once Beads drafting has started', () => {
    expect(getCascadeEditWarningMessage('DRAFTING_BEADS', 'prd')).toBe(
      'Saving this PRD edit will restart Beads/blueprint planning from the edited PRD. Previous Beads versions will be archived and remain available read-only.',
    )
  })

  it('warns when editing PRD at Beads approval', () => {
    expect(getCascadeEditWarningMessage('WAITING_BEADS_APPROVAL', 'prd')).toBe(
      'Saving this PRD edit will restart Beads/blueprint planning from the edited PRD. Previous Beads versions will be archived and remain available read-only.',
    )
  })

  it('does not warn when editing PRD during execution phases', () => {
    expect(getCascadeEditWarningMessage('PRE_FLIGHT_CHECK', 'prd')).toBeNull()
  })

  it('never warns when editing beads', () => {
    expect(getCascadeEditWarningMessage('WAITING_BEADS_APPROVAL', 'beads')).toBeNull()
  })

  it('never warns when editing execution setup', () => {
    expect(getCascadeEditWarningMessage('WAITING_EXECUTION_SETUP_APPROVAL', 'execution_setup_plan')).toBeNull()
  })
})

describe.concurrent('workflow metadata', () => {
  it('keeps cancel available during PR review', () => {
    expect(getAvailableWorkflowActions('WAITING_PR_REVIEW')).toEqual(['merge', 'close_unmerged', 'cancel'])
  })

  it('removes all actions for terminal statuses', () => {
    expect(getAvailableWorkflowActions('COMPLETED')).toEqual([])
    expect(getAvailableWorkflowActions('CANCELED')).toEqual([])
  })

  it('offers no actions for unknown workflow statuses', () => {
    expect(getAvailableWorkflowActions('NOT_A_STATUS')).toEqual([])
    expect(getAvailableWorkflowActions('')).toEqual([])
    expect(getAvailableWorkflowActions('toString')).toEqual([])
  })

  it('provides long-form details for every workflow phase', () => {
    for (const phase of WORKFLOW_PHASES) {
      expect(phase.details.overview.trim().length).toBeGreaterThan(0)
      expect(phase.details.steps.length).toBeGreaterThan(0)
      expect(phase.details.outputs.length).toBeGreaterThan(0)
      expect(phase.details.transitions.length).toBeGreaterThan(0)
    }
  })

  it('describes bounded Git, scoped recovery, and durable Manual QA behavior', () => {
    const preFlight = WORKFLOW_PHASES.find((phase) => phase.id === 'PRE_FLIGHT_CHECK')
    const coding = WORKFLOW_PHASES.find((phase) => phase.id === 'CODING')
    const integration = WORKFLOW_PHASES.find((phase) => phase.id === 'INTEGRATING_CHANGES')
    const manualQa = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_MANUAL_QA')
    const cleanup = WORKFLOW_PHASES.find((phase) => phase.id === 'CLEANING_ENV')
    const blocked = WORKFLOW_PHASES.find((phase) => phase.id === 'BLOCKED_ERROR')

    expect(preFlight?.description).toContain('safe Git path and ref inputs')
    expect(preFlight?.details.steps.join(' ')).toContain('NUL-delimited records')
    expect(coding?.description).toContain('bounded Git resets and commits')
    expect(coding?.description).toContain('records its reset checkpoint before it becomes `in_progress`')
    expect(coding?.details.steps.join(' ')).toContain('the bead stays `pending`')
    expect(coding?.details.notes?.join(' ')).toContain('no execution call starts')
    expect(coding?.details.steps.join(' ')).toContain('attempts a safe reset')
    expect(coding?.details.steps.join(' ')).toContain('authoritative OpenCode step-cap marker')
    expect(coding?.details.notes?.join(' ')).toContain('does not write a common Git exclude rule')
    expect(integration?.description).toContain('unknown untracked additions')
    expect(integration?.details.steps.join(' ')).toContain('identity-bound marker')
    expect(integration?.details.steps.join(' ')).toContain('Invalid or escaped markers fail before recovery writes')
    expect(integration?.details.steps.join(' ')).toContain('remain intact')
    expect(manualQa?.details.steps.join(' ')).toContain('persistent SQLite transaction lock')
    expect(manualQa?.description).toContain('strict no-symlink policy')
    expect(manualQa?.details.steps.join(' ')).toContain('copies a symlink itself')
    expect(manualQa?.details.steps.join(' ')).not.toContain('Final symlinks are inspected')
    expect(cleanup?.description).toContain('selected transient runtime data recursively')
    expect(cleanup?.description).not.toContain('recovery sidecars')
    expect(cleanup?.details.steps.join(' ')).toContain('does not inspect each sidecar')
    expect(blocked?.description).not.toContain('recovery ownership')
    expect(blocked?.details.steps.join(' ')).not.toContain('recovery-blocked diagnostics')
    expect(blocked?.details.notes?.join(' ')).toContain('separate process-level failure')
  })

  it('keeps safe resume guidance in details instead of the top summaries', () => {
    for (const phase of WORKFLOW_PHASES) {
      expect(phase.description).not.toContain('Safe resume:')
      expect(phase.details.notes?.some((note) => note.includes('Safe resume:'))).toBe(true)
    }
  })

  it('documents bounded PR recovery and server-advertised blocked actions', () => {
    const pullRequestPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_PR_REVIEW')
    const blockedPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'BLOCKED_ERROR')
    const blockedDetails = blockedPhase?.details

    expect(pullRequestPhase?.description).toContain('durable closed-unmerged report')
    expect(pullRequestPhase?.details.overview).toContain('fresh remote observation of an already-merged PR')
    expect(pullRequestPhase?.details.notes?.join(' ')).toContain('stale checkpoint for a different PR')
    expect(blockedPhase?.description).toContain('recovery actions the server allows')
    expect(blockedPhase?.description).toContain('Failed runtime setup offers setup-plan editing and an extra-note retry')
    expect(blockedDetails?.overview).toContain('does not invent setup-plan editing')
    expect(blockedDetails?.steps.join(' ')).toContain('A setup-approval error does not itself grant')
    expect(blockedDetails?.steps.join(' ')).toContain('CODING or PREPARING_EXECUTION_ENV failures')
    expect(blockedDetails?.notes?.join(' ')).toContain('does not imply note-bearing retry')
    expect(blockedDetails?.notes?.join(' ')).toContain('Retry needs a recorded previous phase.')
    expect(blockedDetails?.notes?.join(' ')).toContain('same preserved OpenCode session is still recoverable by exact id and durable ownership is available')
    expect(blockedDetails?.notes?.join(' ')).toContain('If both ownership stores are unavailable, a restart cannot prove recovery.')
  })

  it('documents durable interview claims, approval baselines, and safe recovery limits', () => {
    const interview = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_INTERVIEW_ANSWERS')
    const interviewApproval = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_INTERVIEW_APPROVAL')
    const prdApproval = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_PRD_APPROVAL')
    const coding = WORKFLOW_PHASES.find((phase) => phase.id === 'CODING')
    const manualQa = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_MANUAL_QA')
    const canceled = WORKFLOW_PHASES.find((phase) => phase.id === 'CANCELED')
    const blocked = WORKFLOW_PHASES.find((phase) => phase.id === 'BLOCKED_ERROR')

    expect(interview?.description).toContain('positive batch identity')
    expect(interview?.description).toContain('stale or unknown batches are rejected')
    expect(interview?.details.steps.join(' ')).toContain('durable claim ensures only its owner')
    expect(interview?.details.steps.join(' ')).toContain('false, thrown, or unverified stop')

    for (const phase of [interviewApproval, prdApproval]) {
      expect(phase?.description).toContain('loaded content hash')
      expect(phase?.description).toContain('missing or stale baselines fail closed')
      expect(phase?.description).toContain('failed saves keep the draft')
      expect(phase?.description).toContain('queued flushes cannot rebase dirty edits')
      expect(phase?.details.steps.join(' ')).toContain('Structured and raw saves require that baseline')
      expect(phase?.details.steps.join(' ')).toContain('certify an unacknowledged save')
    }

    expect(coding?.description).toContain('finite `maxIterations` cap')
    expect(coding?.description).toContain('`0` means unlimited for that automatic path')
    expect(coding?.description).toContain('user-facing Continue across phases is separate')
    expect(coding?.details.steps.join(' ')).toContain('finite `maxIterations` within each bead iteration')
    expect(coding?.details.steps.join(' ')).toContain('User-facing Continue across workflow phases is a separate path')

    expect(manualQa?.description).toContain('capture the clicked draft, evidence, checklist round, and revision')
    expect(manualQa?.description).toContain('later autosaves cannot replace that snapshot')
    expect(manualQa?.details.steps.join(' ')).toContain('before any await')

    expect(canceled?.description).toContain('If active remote work exists')
    expect(canceled?.description).toContain('stop to be confirmed')
    expect(canceled?.description).toContain('false, thrown, or unverified stop')
    expect(canceled?.details.steps.join(' ')).toContain('cleanup only after the remote stop is confirmed')

    expect(blocked?.description).toContain('both the project database and ticket marker are unavailable')
    expect(blocked?.description).toContain('a restart cannot claim recovery')
    expect(blocked?.details.steps.join(' ')).toContain('only the current process guard remains')
  })

  it('describes the Manual QA producer and consumer clearly', () => {
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'GENERATING_QA_CHECKLIST')?.description).toContain(
      'Manual QA checklist',
    )
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'GENERATING_QA_CHECKLIST')?.description).toContain(
      'candidate checkpoint',
    )
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_MANUAL_QA')?.description).toContain(
      'autosaved Manual QA workspace',
    )
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_MANUAL_QA')?.description).toContain(
      'failed checks create QA-fix work',
    )
  })

  it('separates the Manual QA producer workspace from its interactive consumer', () => {
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'GENERATING_QA_CHECKLIST')?.uiView).toBe('coding')
    expect(WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_MANUAL_QA')?.uiView).toBe('manual_qa')
  })

  it('documents visible autosave state for interview drafts', () => {
    const interviewPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_INTERVIEW_ANSWERS')

    expect(interviewPhase?.description).toContain('Draft answers autosave with visible state and last-save time.')
    expect(interviewPhase?.details.overview).toContain(
      'visible status showing when the server last acknowledged a save',
    )
    expect(interviewPhase?.details.steps).toContain(
      'Answering Questions And Autosave: You can answer questions in any order. Free-text questions accept open-ended responses; choice-based questions present the available options. Draft changes autosave while you work, and the visible Autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time.',
    )
  })

  it('distinguishes autosaved approval drafts from explicit artifact saves', () => {
    const approvalPhaseIds = [
      'WAITING_INTERVIEW_APPROVAL',
      'WAITING_PRD_APPROVAL',
      'WAITING_BEADS_APPROVAL',
      'WAITING_EXECUTION_SETUP_APPROVAL',
    ]

    for (const phaseId of approvalPhaseIds) {
      const phase = WORKFLOW_PHASES.find((candidate) => candidate.id === phaseId)

      expect(phase?.description).toContain('Draft edits autosave with visible state and last-save time')
      expect(phase?.description).toContain(phaseId === 'WAITING_EXECUTION_SETUP_APPROVAL'
        ? 'explicit Save requires the loaded plan hash'
        : 'explicit Save is required to update the authoritative')
      expect(phase?.details.overview).toContain(
        phaseId === 'WAITING_BEADS_APPROVAL'
          ? 'review task descriptions, dependencies, acceptance criteria'
          : 'Draft edits autosave with a visible last-save status',
      )
      expect(phase?.details.steps.join(' ')).toContain(
        'visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state',
      )
      expect(phase?.details.steps.join(' ').toLowerCase()).toContain('explicit save')
    }
  })

  it('shows only ticket details as allowed context while scanning relevant files', () => {
    const scanningPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'SCANNING_RELEVANT_FILES')

    expect(scanningPhase?.contextSummary).toEqual(['ticket_details'])
  })

  it('describes conditional repository grounding for PRD coverage verification', () => {
    const prdCoveragePhase = WORKFLOW_PHASES.find((phase) => phase.id === 'VERIFYING_PRD_COVERAGE')

    expect(prdCoveragePhase?.description).toContain(
      'using focused read-only repository inspection only when needed to confirm repository-specific claims',
    )
    expect(prdCoveragePhase?.contextSummary).toEqual(['full_answers', 'prd'])
  })

  it('describes the two-step beads finalization flow', () => {
    const beadsRefinePhase = WORKFLOW_PHASES.find((phase) => phase.id === 'REFINING_BEADS')

    expect(beadsRefinePhase?.description).toContain('focused read-only repository inspection')
  })

  it('describes beads coverage as a semantic PRD review loop', () => {
    const beadsCoveragePhase = WORKFLOW_PHASES.find((phase) => phase.id === 'VERIFYING_BEADS_COVERAGE')

    expect(beadsCoveragePhase?.description).toContain(
      'LoopTroop checks the semantic beads blueprint against the approved PRD, using focused read-only inspection when required.',
    )
    expect(beadsCoveragePhase?.description).not.toContain('command evidence')
    expect(beadsCoveragePhase?.contextSummary).toEqual(['prd', 'beads'])
    expect(beadsCoveragePhase?.contextSections).toEqual([
      {
        label: 'Coverage Review',
        description: 'Checking Blueprint Against PRD',
        keys: ['prd', 'beads'],
      },
    ])
  })

  it('describes the expanding beads phase as blueprint-to-execution transformation', () => {
    const expandingPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'EXPANDING_BEADS')

    expect(expandingPhase?.description).toContain(
      'LoopTroop transforms the coverage-validated semantic blueprint into execution-ready bead records',
    )
    expect(expandingPhase?.contextSummary).toEqual(['relevant_files', 'ticket_details', 'prd', 'beads_draft'])
    expect(expandingPhase?.contextSections).toEqual([
      {
        label: 'Expansion',
        description: 'Transforming Blueprint into Execution-Ready Beads',
        keys: ['relevant_files', 'ticket_details', 'prd', 'beads_draft'],
      },
    ])
  })

  it('documents the accepted beads contract across planning and approval', () => {
    const drafting = WORKFLOW_PHASES.find((phase) => phase.id === 'DRAFTING_BEADS')
    const voting = WORKFLOW_PHASES.find((phase) => phase.id === 'COUNCIL_VOTING_BEADS')
    const refining = WORKFLOW_PHASES.find((phase) => phase.id === 'REFINING_BEADS')
    const coverage = WORKFLOW_PHASES.find((phase) => phase.id === 'VERIFYING_BEADS_COVERAGE')
    const expanding = WORKFLOW_PHASES.find((phase) => phase.id === 'EXPANDING_BEADS')
    const approval = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_BEADS_APPROVAL')

    expect(drafting?.description).toContain('explicit structured verification commands')
    expect(drafting?.details.steps.join(' ')).toContain('never turns a bare command string into a shell invocation')
    expect(voting?.details.notes?.join(' ')).toContain('structured command and dependency fields')
    expect(refining?.details.steps.join(' ')).toContain('explicit no-command reason')
    expect(coverage?.details.overview).toContain('command absence alone is not a coverage gap')
    expect(expanding?.description).toContain('preserving structured commands and explicit no-command reasons')
    expect(approval?.description).toContain('JSONL diagnostics')
    expect(approval?.details.steps.join(' ')).toContain('source-line diagnostics')
    expect(approval?.details.notes?.join(' ')).toContain('draft base hash')
  })

  it('describes PRD drafting as full answers first and PRD drafts second', () => {
    const prdDraftPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'DRAFTING_PRD')

    expect(prdDraftPhase?.contextSections).toEqual([
      {
        label: 'Part 1',
        description: 'Answering Skipped Questions',
        keys: ['relevant_files', 'ticket_details', 'interview'],
      },
      {
        label: 'Part 2',
        description: 'Generating PRD Drafts',
        keys: ['relevant_files', 'ticket_details', 'full_answers'],
      },
    ])
  })

  it('adds a dedicated preparing-workspace execution phase before coding', () => {
    const preFlightPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'PRE_FLIGHT_CHECK')
    const setupDraftingPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'GENERATING_EXECUTION_SETUP_PLAN')
    const setupApprovalPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_EXECUTION_SETUP_APPROVAL')
    const setupPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'PREPARING_EXECUTION_ENV')
    const codingPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'CODING')

    expect(preFlightPhase?.details.transitions.join(' ')).toContain('All Checks Pass → Drafting Workspace Setup Plan')
    expect(setupDraftingPhase?.label).toBe('Drafting Workspace Setup Plan')
    expect(setupDraftingPhase?.kanbanPhase).toBe('in_progress')
    expect(setupDraftingPhase?.editable).toBe(false)
    expect(setupDraftingPhase?.details.steps.join(' ')).toContain('Visible Progress And Artifacts')
    expect(setupDraftingPhase?.details.outputs.join(' ')).toContain('versioned `execution_setup_plan` candidate')
    expect(setupDraftingPhase?.details.transitions.join(' ')).toContain(
      'Valid Draft → Approving Workspace Setup',
    )
    expect(setupApprovalPhase?.label).toBe('Approving Workspace Setup')
    expect(setupApprovalPhase?.kanbanPhase).toBe('needs_input')
    expect(setupApprovalPhase?.reviewArtifactType).toBe('execution_setup_plan')
    expect(setupApprovalPhase?.details.steps.join(' ')).toContain(
      'Opening the approval screen does not start AI work',
    )
    expect(setupPhase?.label).toBe('Preparing Workspace Runtime')
    expect(setupPhase?.description).toContain('honest Ready or Blocked result')
    expect(setupPhase?.details.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('One Deadline Per Attempt'),
      expect.stringContaining('Deadline Recovery'),
    ]))
    expect(setupPhase?.contextSummary).toEqual(['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'])
    expect(codingPhase?.contextSummary).toEqual(['bead_data', 'bead_notes'])
  })

  it('documents narrowed final test and pull request context', () => {
    const interviewPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'WAITING_INTERVIEW_ANSWERS')
    const finalTestPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'RUNNING_FINAL_TEST')
    const pullRequestPhase = WORKFLOW_PHASES.find((phase) => phase.id === 'CREATING_PULL_REQUEST')

    expect(interviewPhase?.contextSummary).toEqual(['ticket_details'])
    expect(finalTestPhase?.contextSummary).toEqual(['ticket_details', 'prd', 'beads', 'final_test_notes'])
    expect(pullRequestPhase?.contextSummary).toEqual(['ticket_details', 'prd'])
  })
})
