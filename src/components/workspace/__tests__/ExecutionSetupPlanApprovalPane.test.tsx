import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTicket, TEST } from '@/test/factories'
import { createTestQueryClient, renderWithProviders } from '@/test/renderHelpers'
import { getTicketPhaseAttemptsQueryKey } from '@/hooks/useTicketPhaseAttempts'
import { ExecutionSetupPlanApprovalPane } from '../ExecutionSetupPlanApprovalPane'

const mockSaveUiState = vi.fn()
const mockUseTicketUIState = vi.fn()
const mockClearTicketArtifactsCache = vi.fn()
const mockUseTicketArtifacts = vi.fn()
const mockCollapsiblePhaseLogSection = vi.hoisted(() => vi.fn(({
  defaultExpanded,
  phase,
  phaseAttempt,
  logMode,
  variant,
}: {
  defaultExpanded?: boolean
  phase?: string
  phaseAttempt?: number
  logMode?: string
  variant?: string
}) => (
  <div
    data-testid="phase-log-section"
    data-default-expanded={String(defaultExpanded)}
    data-phase={phase}
    data-phase-attempt={phaseAttempt ?? 'active'}
    data-log-mode={logMode ?? 'live'}
    data-variant={variant}
  />
)))

function buildPlan(summary = 'Prepare the workspace runtime.') {
  return {
    schemaVersion: 1,
    ticketId: TEST.externalId,
    artifact: 'execution_setup_plan' as const,
    status: 'draft' as const,
    summary,
    hostContext: { platform: 'linux' as const, environment: 'wsl' as const, arch: 'x64', availableShells: ['posix' as const], preferredShell: 'posix' as const },
    readiness: {
      status: 'partial' as const,
      actionsRequired: true,
      evidence: ['Manifest and lockfile were detected.'],
      gaps: ['Workspace setup outputs still need to be prepared.'],
    },
    tempRoots: ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'],
    workspaceInputs: [],
    workspaceProbes: [{ id: 'workspace', command: { mode: 'process' as const, program: 'project', args: ['test', '--list'], cwd: '.', env: {} }, purpose: 'Load the workspace.' }],
    gitHooks: { policy: 'validate_advisory' as const, detected: [], validationCommands: [] },
    steps: [
      {
        id: 'bootstrap-workspace',
        title: 'Bootstrap workspace',
        purpose: 'Prepare the runtime for later coding.',
        commands: [{ mode: 'process' as const, program: 'project', args: ['bootstrap'], cwd: '.', env: {} }],
        required: true,
        rationale: 'Repository-native setup must run before execution can continue.',
        cautions: ['Can take a while on cold cache.'],
      },
    ],
    projectCommands: {
      prepare: [{ mode: 'process' as const, program: 'project', args: ['bootstrap'], cwd: '.', env: {} }],
      testFull: [{ mode: 'process' as const, program: 'project', args: ['test'], cwd: '.', env: {} }],
      lintFull: [{ mode: 'process' as const, program: 'project', args: ['lint'], cwd: '.', env: {} }],
      typecheckFull: [{ mode: 'process' as const, program: 'project', args: ['typecheck'], cwd: '.', env: {} }],
    },
    qualityGatePolicy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      fullProjectFallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Repository-native bootstrap may create local dependency caches.'],
  }
}

function buildRawPlan(summary = 'Prepare the workspace runtime.') {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary,
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Manifest and lockfile were detected.'],
      gaps: ['Workspace setup outputs still need to be prepared.'],
    },
    temp_roots: ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'],
    workspace_probes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
    git_hooks: { policy: 'validate_advisory', detected: [], validation_commands: [] },
    steps: [
      {
        id: 'bootstrap-workspace',
        title: 'Bootstrap workspace',
        purpose: 'Prepare the runtime for later coding.',
        commands: ['project bootstrap'],
        required: true,
        rationale: 'Repository-native setup must run before execution can continue.',
        cautions: ['Can take a while on cold cache.'],
      },
    ],
    project_commands: {
      prepare: ['project bootstrap'],
      test_full: ['project test'],
      lint_full: ['project lint'],
      typecheck_full: ['project typecheck'],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Repository-native bootstrap may create local dependency caches.'],
  }, null, 2)
}

function buildReportContent(
  source: 'auto' | 'regenerate' = 'auto',
  notes: string[] = ['Prefer the project-native bootstrap command.'],
) {
  return JSON.stringify({
    status: 'draft',
    ready: true,
    generatedAt: '2026-03-25T10:15:00.000Z',
    generatedBy: 'openai/gpt-5',
    summary: 'Prepare the workspace runtime.',
    modelOutput: '<EXECUTION_SETUP_PLAN>\nsummary: generated\n</EXECUTION_SETUP_PLAN>',
    errors: [],
    notes,
    source,
  })
}

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useTicketUIState: (...args: unknown[]) => mockUseTicketUIState(...args),
    useSaveTicketUIState: () => ({ mutateAsync: mockSaveUiState }),
  }
})

vi.mock('@/hooks/useTicketArtifacts', () => ({
  clearTicketArtifactsCache: (...args: unknown[]) => mockClearTicketArtifactsCache(...args),
  useTicketArtifacts: (...args: unknown[]) => mockUseTicketArtifacts(...args),
}))

vi.mock('../PhaseArtifactsPanel', () => ({
  PhaseArtifactsPanel: () => <div data-testid="phase-artifacts-panel" />,
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: mockCollapsiblePhaseLogSection,
}))

vi.mock('../ExecutionSetupPlanEditor', () => ({
  ExecutionSetupPlanEditor: () => <div data-testid="execution-setup-plan-editor" />,
}))

vi.mock('@/components/editor/YamlEditor', () => ({
  YamlEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string
    onChange: (value: string) => void
    className?: string
  }) => (
    <textarea
      aria-label="YAML editor"
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

vi.mock('../ArtifactContentViewer', () => ({
  ArtifactContent: ({
    artifactId,
    content,
    reportContent,
  }: {
    artifactId?: string
    content: string
    reportContent?: string | null
  }) => (
    <div data-testid="artifact-content">
      {artifactId}:{reportContent ? 'with-report' : 'without-report'}:{content.includes('execution_setup_plan') ? 'plan' : 'other'}
    </div>
  ),
}))

describe('ExecutionSetupPlanApprovalPane', () => {
  beforeEach(() => {
    mockSaveUiState.mockReset()
    mockUseTicketUIState.mockReset()
    mockClearTicketArtifactsCache.mockReset()
    mockUseTicketArtifacts.mockReset()
    mockCollapsiblePhaseLogSection.mockClear()
    mockUseTicketUIState.mockReturnValue({
      data: { scope: 'approval_execution_setup', exists: false, data: null, updatedAt: null },
    })
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [
        {
          id: 11,
          ticketId: TEST.ticketId,
          phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
          artifactType: 'execution_setup_plan_report',
          filePath: null,
          content: buildReportContent(),
          createdAt: '2026-03-25T10:15:00.000Z',
        },
        {
          id: 12,
          ticketId: TEST.ticketId,
          phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
          artifactType: 'approval_receipt',
          filePath: null,
          content: JSON.stringify({
            approved_by: 'user',
            approved_at: '2026-03-25T10:30:00.000Z',
            step_count: 1,
            command_count: 1,
          }),
          createdAt: '2026-03-25T10:30:00.000Z',
        },
      ],
      isLoading: false,
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)

      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/execution-setup-plan` && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            exists: true,
            raw: buildRawPlan(),
            contentSha256: 'a'.repeat(64),
            plan: buildPlan(),
            updatedAt: '2026-03-25T10:15:00.000Z',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/execution-setup-plan?phaseAttempt=1` && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            exists: true,
            raw: buildRawPlan('Archived rejected draft.'),
            contentSha256: 'b'.repeat(64),
            plan: buildPlan('Archived rejected draft.'),
            updatedAt: '2026-03-25T10:05:00.000Z',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/regenerate-execution-setup-plan` && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({
            success: true,
            raw: buildRawPlan('Regenerated plan summary.'),
            contentSha256: 'c'.repeat(64),
            plan: buildPlan('Regenerated plan summary.'),
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/approve-execution-setup-plan` && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps setup logs expanded until the generated plan is displayed', async () => {
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })} />)

    let latestLogProps = mockCollapsiblePhaseLogSection.mock.calls[mockCollapsiblePhaseLogSection.mock.calls.length - 1]?.[0]
    expect(latestLogProps).toMatchObject({
      phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
      defaultExpanded: true,
      variant: 'bottom',
    })

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    latestLogProps = mockCollapsiblePhaseLogSection.mock.calls[mockCollapsiblePhaseLogSection.mock.calls.length - 1]?.[0]
    expect(latestLogProps).toMatchObject({
      phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
      defaultExpanded: false,
      phaseAttempt: undefined,
      logMode: 'live',
      variant: 'bottom',
    })
  })

  it('treats a missing approval plan as failed generation with diagnostics and regenerate available', async () => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [
        {
          id: 41,
          ticketId: TEST.ticketId,
          phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
          phaseAttempt: 1,
          artifactType: 'execution_setup_plan_report',
          filePath: null,
          content: JSON.stringify({
            status: 'failed',
            ready: false,
            errors: ['The model response could not be parsed after structured retries.'],
            rawAttempts: [{ attempt: 1, content: 'invalid output' }],
          }),
          createdAt: '2026-03-25T10:15:00.000Z',
        },
      ],
      isLoading: false,
    })
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/execution-setup-plan`) {
        return Promise.resolve(new Response(JSON.stringify({
          exists: false,
          raw: null,
          contentSha256: null,
          plan: null,
          updatedAt: null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })} />)

    expect(await screen.findByText('Setup plan generation needs another attempt')).toBeInTheDocument()
    expect(screen.getByText('The model response could not be parsed after structured retries.')).toBeInTheDocument()
    expect(screen.getByText('Generation diagnostics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate ...' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.queryByText('Building the setup plan.')).not.toBeInTheDocument()
  })

  it('shows draft autosave status beside Save only while editing the active plan', async () => {
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })} />)

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.queryByText(/Draft autosave on/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(await screen.findByTestId('execution-setup-plan-editor')).toBeInTheDocument()
    expect(screen.getByText(/Draft autosave on/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('opens regenerate in a modal from the header and submits commentary through the regenerate route', async () => {
    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })} />, {
      queryClient,
    })

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/execution-setup-plan`,
        expect.objectContaining({ signal: expect.anything() }),
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    const header = screen.getByText('Execution Setup Plan').parentElement
    expect(header).not.toBeNull()

    const headerButtons = within(header!).getAllByRole('button')
    const regenerateIndex = headerButtons.findIndex((button) => button.textContent?.includes('Regenerate ...'))
    const editIndex = headerButtons.findIndex((button) => button.textContent === 'Edit')
    expect(regenerateIndex).toBeGreaterThanOrEqual(0)
    expect(editIndex).toBeGreaterThanOrEqual(0)
    expect(regenerateIndex).toBeLessThan(editIndex)

    fireEvent.click(within(header!).getByRole('button', { name: 'Regenerate ...' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Regenerate setup plan')).toBeInTheDocument()
    expect(within(dialog).getByText(/describe what should change in the readiness assessment or workspace-preparation plan/i)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Please switch to the project-native bootstrap command.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/regenerate-execution-setup-plan`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('Please switch to the project-native bootstrap command.'),
        }),
      )
    })

    await waitFor(() => {
      expect(screen.queryByText('Regenerate setup plan')).not.toBeInTheDocument()
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: getTicketPhaseAttemptsQueryKey(TEST.ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL'),
    })
  })

  it('renders saved setup plan content without mutation controls in read-only mode', async () => {
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'PREPARING_EXECUTION_ENV' })} readOnly />)

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.getByText('Approved Execution Setup Plan')).toBeInTheDocument()
    expect(screen.getByText('Approved setup contract')).toBeInTheDocument()
    expect(screen.getByText('Approved by user')).toBeInTheDocument()
    expect(screen.getByText('1 step')).toBeInTheDocument()
    expect(screen.getByText('1 command')).toBeInTheDocument()
    expect(screen.getByText('Initial generated draft')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Regenerate ...' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('execution-setup-plan-editor')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('YAML editor')).not.toBeInTheDocument()
  })

  it('shows a rewind warning before editing setup approval during runtime setup', async () => {
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'PREPARING_EXECUTION_ENV' })} />)

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.getByRole('button', { name: 'Regenerate ...' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const warning = await screen.findByRole('dialog')
    expect(within(warning).getByText('Return to setup approval?')).toBeInTheDocument()
    expect(within(warning).getByText(/stop Preparing Workspace Runtime/i)).toBeInTheDocument()
    expect(screen.queryByTestId('execution-setup-plan-editor')).not.toBeInTheDocument()

    fireEvent.click(within(warning).getByRole('button', { name: 'Proceed with Edit' }))

    expect(await screen.findByTestId('execution-setup-plan-editor')).toBeInTheDocument()
  })

  it('shows a rewind warning before opening runtime setup regeneration', async () => {
    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'PREPARING_EXECUTION_ENV' })} />, {
      queryClient,
    })

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate ...' }))

    const warning = await screen.findByRole('dialog')
    expect(within(warning).getByText('Return to setup approval?')).toBeInTheDocument()
    fireEvent.click(within(warning).getByRole('button', { name: 'Regenerate Plan' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Regenerate setup plan')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Regenerate after runtime setup started.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/regenerate-execution-setup-plan`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Regenerate after runtime setup started.'),
        }),
      )
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: getTicketPhaseAttemptsQueryKey(TEST.ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL'),
    })
  })

  it('shows regenerate commentary on the active approval draft', async () => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [
        {
          id: 31,
          ticketId: TEST.ticketId,
          phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
          phaseAttempt: 2,
          artifactType: 'execution_setup_plan_report',
          filePath: null,
          content: buildReportContent('regenerate', ['Use pnpm install before running the test suite.']),
          createdAt: '2026-03-25T10:20:00.000Z',
        },
      ],
      isLoading: false,
    })

    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })} />)

    expect(await screen.findByText('Regeneration Request')).toBeInTheDocument()
    expect(screen.getByText('Use pnpm install before running the test suite.')).toBeInTheDocument()
  })

  it('labels archived setup plan attempts as rejected drafts', async () => {
    mockUseTicketArtifacts.mockImplementation((_ticketId: string, options?: { phase?: string; phaseAttempt?: number }) => ({
      artifacts: options?.phaseAttempt === 1
        ? [
          {
            id: 21,
            ticketId: TEST.ticketId,
            phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
            phaseAttempt: 1,
            artifactType: 'execution_setup_plan_report',
            filePath: null,
            content: buildReportContent('regenerate', ['Please switch to the project-native bootstrap command.']),
            createdAt: '2026-03-25T10:05:00.000Z',
          },
        ]
        : [],
      isLoading: false,
    }))

    renderWithProviders(
      <ExecutionSetupPlanApprovalPane
        ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })}
        readOnly
        phaseAttempt={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.getByText('Rejected Execution Setup Draft')).toBeInTheDocument()
    expect(screen.getByText('Rejected setup draft')).toBeInTheDocument()
    expect(screen.getByText('Rejected draft')).toBeInTheDocument()
    expect(screen.getByText('Regenerated before approval')).toBeInTheDocument()
    expect(screen.getByText('Please switch to the project-native bootstrap command.')).toBeInTheDocument()
    expect(screen.getByText(/not handed to Preparing Workspace Runtime/i)).toBeInTheDocument()
    expect(screen.queryByText('Approved setup contract')).not.toBeInTheDocument()
    expect(screen.queryByText('Approved')).not.toBeInTheDocument()
    expect(mockUseTicketArtifacts).toHaveBeenCalledWith(TEST.ticketId, {
      phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
      phaseAttempt: 1,
    })
    const latestLogProps = mockCollapsiblePhaseLogSection.mock.calls[mockCollapsiblePhaseLogSection.mock.calls.length - 1]?.[0]
    expect(latestLogProps).toMatchObject({
      phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
      phaseAttempt: 1,
      logMode: 'snapshot',
    })
  })

  it('labels archived approved setup plan attempts as superseded contracts', async () => {
    mockUseTicketArtifacts.mockImplementation((_ticketId: string, options?: { phase?: string; phaseAttempt?: number }) => ({
      artifacts: options?.phaseAttempt === 1
        ? [
          {
            id: 21,
            ticketId: TEST.ticketId,
            phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
            phaseAttempt: 1,
            artifactType: 'execution_setup_plan_report',
            filePath: null,
            content: buildReportContent('auto'),
            createdAt: '2026-03-25T10:05:00.000Z',
          },
          {
            id: 22,
            ticketId: TEST.ticketId,
            phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
            phaseAttempt: 1,
            artifactType: 'approval_receipt',
            filePath: null,
            content: JSON.stringify({
              approved_by: 'user',
              approved_at: '2026-03-25T10:30:00.000Z',
              step_count: 1,
              command_count: 1,
            }),
            createdAt: '2026-03-25T10:30:00.000Z',
          },
        ]
        : [],
      isLoading: false,
    }))

    renderWithProviders(
      <ExecutionSetupPlanApprovalPane
        ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })}
        readOnly
        phaseAttempt={1}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.getByText('Superseded Execution Setup Contract')).toBeInTheDocument()
    expect(screen.getByText('Superseded approved setup contract')).toBeInTheDocument()
    expect(screen.getByText('Superseded')).toBeInTheDocument()
    expect(screen.getByText(/handed to Preparing Workspace Runtime/i)).toBeInTheDocument()
    expect(screen.queryByText('Rejected setup draft')).not.toBeInTheDocument()
  })

  it('ignores persisted edit mode while rendering read-only setup plan review', async () => {
    mockUseTicketUIState.mockReturnValue({
      data: {
        scope: 'approval_execution_setup',
        exists: true,
        updatedAt: '2026-03-25T10:15:00.000Z',
        data: {
          editMode: true,
          editTab: 'raw',
          rawDraft: buildRawPlan('Unsaved persisted draft.'),
          structuredDraft: buildPlan('Unsaved persisted draft.'),
          commentary: 'Regenerate this later.',
        },
      },
    })

    renderWithProviders(<ExecutionSetupPlanApprovalPane ticket={makeTicket({ status: 'PREPARING_EXECUTION_ENV' })} readOnly />)

    await waitFor(() => {
      expect(screen.getByTestId('artifact-content')).toHaveTextContent('execution-setup-plan:with-report:plan')
    })

    expect(screen.queryByTestId('execution-setup-plan-editor')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('YAML editor')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved persisted draft.')).not.toBeInTheDocument()
  })
})
