import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { renderWithProviders } from '@/test/renderHelpers'
import { normalizeTicketResponse } from '@/lib/ticketNormalization'
import { makeTicket } from '@/test/factories'
import { DashboardHeader } from '../DashboardHeader'

const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseProfile = vi.hoisted(() => vi.fn())
const mockUseTicketAction = vi.hoisted(() => vi.fn())
const mockUseCancelTicket = vi.hoisted(() => vi.fn())
const mockUseUpdateTicket = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockUseProjects(),
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => mockUseProfile(),
}))

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useTicketAction: () => mockUseTicketAction(),
    useCancelTicket: () => mockUseCancelTicket(),
    useUpdateTicket: () => mockUseUpdateTicket(),
  }
})

function makeFilters(): UIContextValue['state']['filters'] {
  return {
    projectId: null,
    status: null,
    phase: null,
    search: '',
    priority: null,
    stuckDays: null,
    errorState: 'none',
    sortBy: 'updatedAt_desc',
    showMocks: true,
  }
}

function makeUIValue(ticketId: string, externalId: string): UIContextValue {
  return {
    state: {
      selectedTicketId: ticketId,
      selectedTicketExternalId: externalId,
      sidebarOpen: true,
      activeView: 'ticket',
      logPanelHeight: 320,
      filters: makeFilters(),
      presetsByProject: {},
      theme: 'system',
      showTriageBar: false,
    },
    dispatch: vi.fn(),
  }
}

describe('DashboardHeader', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.restoreAllMocks()
  })

  beforeAll(() => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
    })
  })

  beforeEach(() => {
    mockUseProjects.mockReturnValue({
      data: [
        {
          id: 1,
          name: 'Acme Console',
          shortname: 'ACME',
          icon: '🧭',
          color: '#2563eb',
          folderPath: '/tmp/acme-console',
          profileId: null,
          councilMembers: null,
          maxIterations: null,
          perIterationTimeout: null,
          councilResponseTimeout: null,
          minCouncilQuorum: null,
          interviewQuestions: null,
          ticketCounter: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    mockUseProfile.mockReturnValue({ data: null })
    mockUseTicketAction.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mockUseCancelTicket.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutateAsync: vi.fn() })
  })

  it.each(['Copy path', 'Copy description'])('shows a failure for %s and clears it after retry', async (name) => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const ticket = makeTicket({ status: 'DRAFTING_PRD', projectId: 1, description: 'Example description' })
    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const button = screen.getAllByRole('button', { name })[0]!
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed')
    fireEvent.click(button)
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument() })
  })

  it('reveals the artifact folder and reports a failed reveal request', async () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD', projectId: 1 })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error('File manager unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const location = screen.getByText('Artifacts Location').parentElement as HTMLElement
    const openButton = within(location).getAllByRole('button')[0]!

    await act(async () => { fireEvent.click(openButton) })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/files/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ticket.runtime.artifactRoot }),
    })
    await waitFor(() => { expect(openButton).not.toBeDisabled() })

    await act(async () => { fireEvent.click(openButton) })
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Error opening path:', expect.any(Error))
      expect(openButton).not.toBeDisabled()
    })
  })

  it('renders a project data icon as an image', () => {
    const icon = 'data:image/png;base64,ZmFrZQ=='
    mockUseProjects.mockReturnValue({
      data: [{
        id: 1,
        name: 'Acme Console',
        shortname: 'ACME',
        icon,
        color: '#2563eb',
        folderPath: '/tmp/acme-console',
      }],
    })
    const ticket = makeTicket({ status: 'DRAFTING_PRD', projectId: 1 })

    const { container } = renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(container.querySelector('img')).toHaveAttribute('src', icon)
  })

  it('saves a trimmed title on Enter and discards edits on Escape', async () => {
    const updateTicket = vi.fn().mockResolvedValue(undefined)
    mockUseUpdateTicket.mockReturnValue({ mutateAsync: updateTicket })
    const ticket = makeTicket({ status: 'DRAFT', title: 'Original title' })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByRole('textbox')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '  Updated title  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(updateTicket).toHaveBeenCalledWith({ id: ticket.id, title: 'Updated title' })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const secondInput = screen.getByRole('textbox')
    fireEvent.change(secondInput, { target: { value: 'Unsaved title' } })
    fireEvent.keyDown(secondInput, { key: 'Escape' })

    expect(screen.getByRole('heading', { name: ticket.title })).toBeInTheDocument()
    expect(updateTicket).toHaveBeenCalledOnce()
  })

  it('does not submit an empty title and restores the title if saving fails', async () => {
    const updateTicket = vi.fn().mockRejectedValue(new Error('offline'))
    mockUseUpdateTicket.mockReturnValue({ mutateAsync: updateTicket })
    const ticket = makeTicket({ status: 'DRAFT', title: 'Original title' })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const blankInput = screen.getByRole('textbox')
    fireEvent.change(blankInput, { target: { value: '   ' } })
    fireEvent.keyDown(blankInput, { key: 'Enter' })

    await waitFor(() => { expect(screen.queryByRole('textbox')).not.toBeInTheDocument() })
    expect(updateTicket).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const failingInput = screen.getByRole('textbox')
    fireEvent.change(failingInput, { target: { value: 'Changed title' } })
    fireEvent.keyDown(failingInput, { key: 'Enter' })

    await waitFor(() => {
      expect(updateTicket).toHaveBeenCalledWith({ id: ticket.id, title: 'Changed title' })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: ticket.title })).toBeInTheDocument()
  })

  it('dispatches close when the dashboard close button is selected', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD' })
    const uiValue = makeUIValue(ticket.id, ticket.externalId)

    renderWithProviders(
      <UIContext.Provider value={uiValue}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dashboard' }))

    expect(uiValue.dispatch).toHaveBeenCalledWith({ type: 'CLOSE_TICKET' })
  })

  it('shows deterministic bead completion and the ETA range during execution', () => {
    const base = makeTicket()
    const ticket = makeTicket({
      status: 'CODING',
      availableActions: ['cancel'],
      runtime: {
        ...base.runtime,
        currentBead: 4,
        completedBeads: 3,
        totalBeads: 10,
        percentComplete: 30,
        eta: { bestMs: 600000, likelyMs: 900000, worstMs: 1500000, basis: 'current' },
      },
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByText('3/10 (30%)')).toBeInTheDocument()
    // EtaRange renders the "likely" duration with a "~" prefix (900000ms -> 15m).
    expect(screen.getByText('~15m')).toBeInTheDocument()
  })

  it('omits the ETA chip when no estimate is available yet', () => {
    const base = makeTicket()
    const ticket = makeTicket({
      status: 'CODING',
      availableActions: ['cancel'],
      runtime: {
        ...base.runtime,
        currentBead: 4,
        completedBeads: 3,
        totalBeads: 10,
        percentComplete: 30,
        eta: null,
      },
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByText('3/10 (30%)')).toBeInTheDocument()
    expect(screen.queryByText('~15m')).not.toBeInTheDocument()
  })

  it('shows the project as its own details field above priority', async () => {
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    const titleSection = screen.getByText('Title').parentElement
    const projectSection = screen.getByText('Project').parentElement
    expect(titleSection).not.toBeNull()
    expect(projectSection).not.toBeNull()
    expect(within(titleSection as HTMLElement).getByText(ticket.title)).toBeInTheDocument()
    expect(within(projectSection as HTMLElement).getByText('Acme Console')).toBeInTheDocument()
    expect(within(projectSection as HTMLElement).getByText('🧭')).toBeInTheDocument()
  })

  it('only spans the title across two columns when the details dialog uses its wider layout', () => {
    mockUseProjects.mockReturnValue({ data: [] })
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
      projectId: 999,
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    expect(screen.getByText('Title').parentElement).toHaveClass('sm:col-span-2')
    expect(screen.getByText('Title').parentElement).not.toHaveClass('col-span-2')
  })

  it('shows pause-aware implementation time and its delivery breakdown in Details', async () => {
    const ticket = makeTicket({
      status: 'RUNNING_FINAL_TEST',
      startedAt: '2026-01-01T08:00:00.000Z',
      implementationTiming: {
        activeDurationMs: 65 * 60_000,
        startedAt: '2026-01-01T09:00:00.000Z',
        lastPlannedBeadFinishedAt: '2026-01-01T11:00:00.000Z',
        manualQaFixDurationMs: 9 * 60_000,
        manualQaFixStartedAt: '2026-01-01T11:30:00.000Z',
        workspacePreparationDurationMs: 12 * 60_000,
        workspacePreparationStartedAt: '2026-01-01T08:48:00.000Z',
        finalTestingDurationMs: 8 * 60_000,
        finalTestingStartedAt: '2026-01-01T11:00:00.000Z',
        questionWaitingMs: 0,
      },
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    expect(screen.getByText('Actual implementation time')).toBeInTheDocument()
    expect(screen.getByText('1h 5m')).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.pointerMove(screen.getByRole('button', { name: 'About actual implementation time' }))
    expect((await screen.findAllByText(/Time actively spent running the originally planned beads/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Workspace preparation:/).at(-1)?.parentElement).toHaveTextContent('12m')
    expect(screen.getAllByText(/Final testing:/).at(-1)?.parentElement).toHaveTextContent('8m')
    expect(screen.getAllByText(/Manual QA fix beads:/).at(-1)?.parentElement).toHaveTextContent('9m')
    expect(screen.getAllByText(/implementation delivery time is 1h 34m/).length).toBeGreaterThan(0)
  })

  it('marks unfinished and unstarted timing stages as unavailable in the implementation-time help', async () => {
    const ticket = makeTicket({
      status: 'CODING',
      startedAt: '2026-01-01T08:00:00.000Z',
      implementationTiming: {
        activeDurationMs: 5 * 60_000,
        startedAt: '2026-01-01T09:00:00.000Z',
        lastPlannedBeadFinishedAt: null,
        manualQaFixDurationMs: 0,
        manualQaFixStartedAt: null,
        workspacePreparationDurationMs: 0,
        workspacePreparationStartedAt: null,
        finalTestingDurationMs: 0,
        finalTestingStartedAt: null,
        questionWaitingMs: 0,
      },
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    fireEvent.pointerMove(screen.getByRole('button', { name: 'About actual implementation time' }))
    expect((await screen.findAllByText('N/A')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Workspace preparation:/).at(-1)?.parentElement).toHaveTextContent('N/A')
    expect(screen.getAllByText(/Final testing:/).at(-1)?.parentElement).toHaveTextContent('N/A')
    expect(screen.getAllByText(/Manual QA fix beads:/).at(-1)?.parentElement).toHaveTextContent('N/A')
  })

  it('shows only the ticket-level Manual QA setting in Details', () => {
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
      effectiveManualQaEnabled: true,
      effectiveGitHookPolicy: 'observe_only',
      lockedMainImplementer: 'openai/gpt-5.4',
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    const advancedSettings = screen.getByText('Advanced Settings').parentElement
    expect(advancedSettings).not.toBeNull()
    expect(within(advancedSettings as HTMLElement).getByText('Manual QA checkpoint')).toBeInTheDocument()
    expect(within(advancedSettings as HTMLElement).getByText('Enabled')).toBeInTheDocument()
    expect(within(advancedSettings as HTMLElement).queryByText('Git hook policy')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Manual QA checkpoint/ })).not.toBeInTheDocument()
    const modelsSelected = screen.getByText('Models Selected')
    expect(modelsSelected.compareDocumentPosition(advancedSettings as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows Manual QA as disabled in Details when the effective setting is off', () => {
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
      effectiveManualQaEnabled: false,
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const advancedSettings = screen.getByText('Advanced Settings').parentElement
    expect(within(advancedSettings as HTMLElement).getByText('Disabled')).toBeInTheDocument()
  })

  it('shows ticket details descriptions as Markdown without view tabs', () => {
    const ticket = makeTicket({
      description: '# Scope\nUse **bold** details.',
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    expect(screen.getByRole('heading', { name: 'Scope' })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByRole('tab', { name: 'Markdown' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument()
  })

  it('lists cleanup warnings when the warning count is opened', async () => {
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      cleanup: {
        status: 'warning',
        errorCount: 2,
        latestReportArtifactId: null,
        errors: ['Unable to remove worktree files', 'Unable to prune the local branch'],
      },
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const warningTrigger = screen.getByText('2 warnings').parentElement as HTMLElement
    fireEvent.pointerMove(warningTrigger)
    fireEvent.mouseEnter(warningTrigger)

    expect(await screen.findByText('Cleanup Warnings:')).toBeInTheDocument()
    expect(screen.getByText('Unable to remove worktree files')).toBeInTheDocument()
    expect(screen.getByText('Unable to prune the local branch')).toBeInTheDocument()
  })

  it('marks display-only mock tickets in the header and details external ID', () => {
    const ticket = makeTicket({
      isDisplayOnlyMock: true,
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByLabelText(`${ticket.externalId} mock demo ticket`)).toHaveTextContent(`${ticket.externalId}(M)`)

    fireEvent.click(screen.getByRole('button', { name: /details/i }))

    const externalIdSection = screen.getByText('External ID').parentElement
    expect(externalIdSection).not.toBeNull()
    expect(within(externalIdSection as HTMLElement).getByLabelText(`${ticket.externalId} mock demo ticket`))
      .toHaveTextContent(`${ticket.externalId}(M)`)
  })

  it('shows the cancel button labeled "Cancel…" when cancel action is available on a non-DRAFT ticket', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByRole('button', { name: /cancel…/i })).toBeInTheDocument()
  })

  it('renders status and actions with defaults when the server sent a partial ticket', () => {
    // The header reads `ticket.runtime` and `ticket.availableActions` directly
    // now; the boundary is what turns a payload missing them into a complete
    // ticket, so the test goes through the boundary rather than around it.
    const ticket = normalizeTicketResponse({
      ...makeTicket({ status: 'CODING', currentBead: 1, totalBeads: 3 }),
      runtime: undefined,
      availableActions: undefined,
      lockedCouncilMembers: null,
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByText('Implementing (Bead 1/3)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
  })

  it('shows the cancel button labeled "Cancel…" for a DRAFT ticket', () => {
    const ticket = makeTicket({ status: 'DRAFT', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    expect(screen.getByRole('button', { name: /cancel…/i })).toBeInTheDocument()
  })

  it('requires confirmation before canceling a DRAFT ticket', async () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, mutateAsync: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFT', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))

    expect(cancelMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Cancel Ticket')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Ticket' }))
    })

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: false, deleteTicket: false, reason: '' },
    })
  })

  it('opens cancel confirmation dialog with both checkboxes unchecked', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))

    expect(screen.getByText('Cancel Ticket')).toBeInTheDocument()
    const deleteContentCheckbox = screen.getByTestId('delete-content-checkbox') as HTMLInputElement
    const deleteLogCheckbox = screen.getByTestId('delete-log-checkbox') as HTMLInputElement
    expect(deleteContentCheckbox.checked).toBe(false)
    expect(deleteLogCheckbox.checked).toBe(false)
  })

  it('calls cancelTicket with deleteContent=false and deleteLog=false by default', async () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, mutateAsync: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))
    })

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: false, deleteTicket: false, reason: '' },
    })
  })

  it('passes deleteContent=true when the checkbox is checked before confirming', async () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, mutateAsync: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByTestId('delete-content-checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))
    })

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: true, deleteLog: false, deleteTicket: false, reason: '' },
    })
  })

  it('passes deleteLog=true when only the log checkbox is checked', async () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, mutateAsync: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByTestId('delete-log-checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))
    })

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: true, deleteTicket: false, reason: '' },
    })
  })

  it('passes deleteTicket=true and checks disabled state when delete ticket checkbox is checked', async () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, mutateAsync: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    
    const deleteContentCheckbox = screen.getByTestId('delete-content-checkbox') as HTMLInputElement
    const deleteLogCheckbox = screen.getByTestId('delete-log-checkbox') as HTMLInputElement
    const deleteTicketCheckbox = screen.getByTestId('delete-ticket-checkbox') as HTMLInputElement
    
    expect(deleteContentCheckbox.disabled).toBe(false)
    expect(deleteLogCheckbox.disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Yes, Cancel Ticket' })).toBeInTheDocument()

    // Check delete ticket completely
    fireEvent.click(deleteTicketCheckbox)

    // First two checkboxes should now be disabled and checked
    expect(deleteContentCheckbox.disabled).toBe(true)
    expect(deleteLogCheckbox.disabled).toBe(true)
    expect(deleteContentCheckbox.checked).toBe(true)
    expect(deleteLogCheckbox.checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Yes, Delete Ticket' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete Ticket' }))
    })

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: true, deleteLog: true, deleteTicket: true },
    })
  })

  it('resets checkboxes to unchecked when dialog is closed via Keep Ticket', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    // Open and check a box, then close
    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByTestId('delete-content-checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /keep ticket/i }))

    // Re-open and verify the box is reset
    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    const deleteContentCheckbox = screen.getByTestId('delete-content-checkbox') as HTMLInputElement
    expect(deleteContentCheckbox.checked).toBe(false)
  })

  /**
   * A ticket that has written nothing to disk reports a total of zero, and every
   * segment of the allocation bar divided by it — producing `width: NaN%`, which the
   * browser drops, so the bar rendered at whatever width the last one had.
   */
  describe('the disk allocation bar', () => {
    async function openSizeBreakdown(size: number, breakdown: unknown = {
      logs: { total: 0, children: [] },
      artifacts: { total: 0, children: [] },
      source: { total: 0, children: [] },
    }) {
      const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        size,
        breakdown,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

      renderWithProviders(
        <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
          <DashboardHeader ticket={ticket} />
        </UIContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: /details/i }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /calculate size/i }))
      })
      return screen.getByTitle(/^Source Code:/).parentElement as HTMLElement
    }

    it('shows a size request error and allows a successful retry', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Disk scan failed'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ size: 42 }), { status: 200 }))
      const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

      renderWithProviders(
        <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
          <DashboardHeader ticket={ticket} />
        </UIContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: /details/i }))
      fireEvent.click(screen.getByRole('button', { name: /calculate size/i }))

      expect(await screen.findByText('Disk scan failed')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /calculate size/i }))

      expect(await screen.findByText('Occupied')).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('gives every segment a real width when the ticket occupies nothing', async () => {
      const bar = await openSizeBreakdown(0)

      for (const segment of Array.from(bar.children)) {
        expect((segment as HTMLElement).style.width).toBe('0%')
      }
    })

    it('still proportions the segments when the ticket occupies something', async () => {
      const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        size: 200,
        breakdown: {
          logs: { total: 50, children: [] },
          artifacts: { total: 50, children: [] },
          source: { total: 100, children: [] },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

      renderWithProviders(
        <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
          <DashboardHeader ticket={ticket} />
        </UIContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: /details/i }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /calculate size/i }))
      })

      expect(screen.getByTitle(/^Source Code:/)).toHaveStyle({ width: '50%' })
      expect(screen.getByTitle(/^Execution Logs:/)).toHaveStyle({ width: '25%' })
    })

    it('expands source and artifact trees and lists execution log files', async () => {
      await openSizeBreakdown(4096, {
        logs: { total: 1024, children: [{ name: 'worker.log', size: 1024, isDirectory: false }] },
        artifacts: {
          total: 1024,
          children: [
            { name: 'empty-artifacts', size: 0, isDirectory: true },
            { name: 'prd.json', size: 1024, isDirectory: false },
          ],
        },
        source: {
          total: 2048,
          children: [{
            name: 'src',
            size: 2048,
            isDirectory: true,
            children: [{ name: 'main.ts', size: 1024, isDirectory: false }],
          }],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /source code/i }))
      const sourceFolder = screen.getByRole('button', { name: /src/ })
      expect(sourceFolder).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(sourceFolder)
      expect(sourceFolder).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('main.ts')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /phase artifacts/i }))
      expect(screen.getByText('empty-artifacts')).toBeInTheDocument()
      expect(screen.getByText('prd.json')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /empty-artifacts/ })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /execution logs/i }))
      expect(screen.getByText('worker.log')).toBeInTheDocument()
    })
  })
})
