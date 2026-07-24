import { fireEvent, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { renderWithProviders } from '@/test/renderHelpers'
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
    mockUseCancelTicket.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutateAsync: vi.fn() })
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

  it('shows pause-aware implementation time and its delivery breakdown in Details', async () => {
    const ticket = makeTicket({
      status: 'RUNNING_FINAL_TEST',
      startedAt: '2026-01-01T08:00:00.000Z',
      implementationTiming: {
        activeDurationMs: 65 * 60_000,
        startedAt: '2026-01-01T09:00:00.000Z',
        lastBeadFinishedAt: '2026-01-01T11:00:00.000Z',
        workspacePreparationDurationMs: 12 * 60_000,
        finalTestingDurationMs: 8 * 60_000,
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
    fireEvent.pointerMove(screen.getByRole('button', { name: 'About actual implementation time' }))
    expect((await screen.findAllByText(/Time actively spent running beads/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Workspace preparation:/).at(-1)?.parentElement).toHaveTextContent('12m')
    expect(screen.getAllByText(/Final testing:/).at(-1)?.parentElement).toHaveTextContent('8m')
    expect(screen.getAllByText(/implementation delivery time is 1h 25m/).length).toBeGreaterThan(0)
  })

  it('shows effective Manual QA and Git hook settings in Details', () => {
    const ticket = makeTicket({
      status: 'DRAFTING_PRD',
      availableActions: ['cancel'],
      effectiveManualQaEnabled: true,
      effectiveGitHookPolicy: 'ignore_internal_only',
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
    expect(within(advancedSettings as HTMLElement).getByText('Git hook policy')).toBeInTheDocument()
    expect(within(advancedSettings as HTMLElement).getByText('Ignore')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open documentation for ticket Git hook policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#git-hook-policy`,
    )
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

  it('renders status and actions with defaults when cached ticket data is partial', () => {
    const ticket = {
      ...makeTicket({ status: 'CODING', currentBead: 1, totalBeads: 3 }),
      runtime: undefined,
      availableActions: undefined,
      lockedCouncilMembers: null,
    } as unknown as ReturnType<typeof makeTicket>

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

  it('requires confirmation before canceling a DRAFT ticket', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFT', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))

    expect(cancelMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Cancel Ticket')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Ticket' }))

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: false, deleteTicket: false },
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

  it('calls cancelTicket with deleteContent=false and deleteLog=false by default', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: false, deleteTicket: false },
    })
  })

  it('passes deleteContent=true when the checkbox is checked before confirming', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByTestId('delete-content-checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: true, deleteLog: false, deleteTicket: false },
    })
  })

  it('passes deleteLog=true when only the log checkbox is checked', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })

    const ticket = makeTicket({ status: 'DRAFTING_PRD', availableActions: ['cancel'] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue(ticket.id, ticket.externalId)}>
        <DashboardHeader ticket={ticket} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    fireEvent.click(screen.getByTestId('delete-log-checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel ticket/i }))

    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: true, deleteTicket: false },
    })
  })

  it('passes deleteTicket=true and checks disabled state when delete ticket checkbox is checked', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })

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

    fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete Ticket' }))

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
})
