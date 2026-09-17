import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { renderWithProviders } from '@/test/renderHelpers'
import { TicketForm } from '../TicketForm'
import type { Ticket } from '@/hooks/useTickets'

const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseCreateTicket = vi.hoisted(() => vi.fn())
const mockUseUpdateTicket = vi.hoisted(() => vi.fn())
const mockUseTicketAction = vi.hoisted(() => vi.fn())
const mockAddToast = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockUseProjects(),
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { manualQaEnabled: false, gitHookPolicy: 'validate_advisory' } }),
}))

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useCreateTicket: () => mockUseCreateTicket(),
    useUpdateTicket: () => mockUseUpdateTicket(),
    useTicketAction: () => mockUseTicketAction(),
  }
})

vi.mock('@/components/shared/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}))

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

function makeUIValue(): UIContextValue {
  return {
    state: {
      selectedTicketId: null,
      selectedTicketExternalId: null,
      sidebarOpen: true,
      activeView: 'kanban',
      logPanelHeight: 320,
      filters: makeFilters(),
      presetsByProject: {},
      theme: 'system',
      showTriageBar: false,
    },
    dispatch: vi.fn(),
  }
}

describe('TicketForm', () => {
  beforeEach(() => {
    mockAddToast.mockReset()
    mockUseProjects.mockReturnValue({
      data: [{
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
        manualQaOverride: true,
        gitHookPolicy: 'observe_only',
        ticketCounter: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    mockUseCreateTicket.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mockUseTicketAction.mockReturnValue({ mutateAsync: vi.fn(), isPending: false })
  })

  it('defaults the description view to Raw and previews Markdown on demand', () => {
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )

    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true')

    const textarea = screen.getByRole('textbox', { name: 'Ticket description' })
    fireEvent.change(textarea, { target: { value: '# Scope\nUse **bold** details.' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }))
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('shows only enabled and disabled Manual QA choices for ordinary new tickets', async () => {
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )

    const advancedButton = screen.getByRole('button', { name: /Advanced/ })
    expect(advancedButton.parentElement).toHaveClass('border-2')
    fireEvent.click(advancedButton)
    expect(screen.getByText('Manual QA checkpoint')).toBeInTheDocument()
    const manualQa = within(screen.getByRole('radiogroup', { name: 'Manual QA setting' }))
    expect(manualQa.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Effective setting:/)).not.toBeInTheDocument()
    expect(screen.queryByText('Git hook policy')).not.toBeInTheDocument()
    const helpLink = screen.getByRole('link', { name: 'Open documentation for ticket Manual QA checkpoint' })
    expect(helpLink).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    fireEvent.focus(helpLink)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Choose whether this ticket pauses for your verification after final tests.')
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Verify checkout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
    expect(mockUseCreateTicket().mutate.mock.calls[0]?.[0]).not.toHaveProperty('gitHookPolicy')
  })

  it('reports a failed ticket creation instead of leaving the form silent', () => {
    const mutate = vi.fn((_input, options) => {
      options.onError(new Error('Project is unavailable'))
    })
    mockUseCreateTicket.mockReturnValue({ mutate, mutateAsync: vi.fn(), isPending: false })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Create a ticket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))

    expect(mockAddToast).toHaveBeenCalledWith('error', 'Unable to create ticket: Project is unavailable', 5000)
  })

  it('keeps the effective default project clean when it is selected explicitly', () => {
    const dirty = vi.fn()
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} onDirtyChange={dirty} />
      </UIContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Acme Console \(ACME\)/ }))
    const projectOptions = screen.getAllByRole('button', { name: /Acme Console \(ACME\)/ })
    fireEvent.click(projectOptions.at(-1)!)

    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('keeps later ticket edits open when an earlier create succeeds', () => {
    const mutate = vi.fn()
    const update = vi.fn()
    const onClose = vi.fn()
    mockUseCreateTicket.mockReturnValue({ mutate, mutateAsync: vi.fn(), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutate: update, isPending: false })
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={onClose} />
      </UIContext.Provider>,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Saved ticket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Later ticket' } })
    const options = mutate.mock.calls[0]?.[1] as { onSuccess: (created: Ticket) => void }
    act(() => options.onSuccess({ id: '1:ACME-2', status: 'DRAFT' } as Ticket))

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Ticket' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Ticket' }))
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1:ACME-2', title: 'Later ticket' }),
      expect.any(Object),
    )
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('saves supported edits by ID after create-and-start without sending locked settings', async () => {
    let resolveCreate!: (ticket: Ticket) => void
    let resolveStart!: (result: { status: string }) => void
    const createPromise = new Promise<Ticket>((resolve) => { resolveCreate = resolve })
    const startPromise = new Promise<{ status: string }>((resolve) => { resolveStart = resolve })
    const update = vi.fn()
    mockUseCreateTicket.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(() => createPromise), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutate: update, isPending: false })
    mockUseTicketAction.mockReturnValue({ mutateAsync: vi.fn(() => startPromise), isPending: false })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Initial ticket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create & Start' }))
    await act(async () => resolveCreate({ id: '1:ACME-3', externalId: 'ACME-3', status: 'DRAFT' } as Ticket))

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Later title' } })
    await act(async () => resolveStart({ status: 'IN_PROGRESS' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save Ticket' }))
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1:ACME-3', title: 'Later title' }),
      expect.any(Object),
    )
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('manualQaOverride')
  })

  it('keeps a created draft editable when create-and-start cannot start it', async () => {
    const update = vi.fn()
    const onClose = vi.fn()
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    mockUseCreateTicket.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: '1:ACME-4', externalId: 'ACME-4', status: 'DRAFT' } as Ticket),
      isPending: false,
    })
    mockUseUpdateTicket.mockReturnValue({ mutate: update, isPending: false })
    mockUseTicketAction.mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new Error('model unavailable')),
      isPending: false,
    })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={onClose} />
      </UIContext.Provider>,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Created draft' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create & Start' })))

    expect(alert).toHaveBeenCalledWith('Ticket created, but it could not start: model unavailable')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Ticket' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save Ticket' }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: '1:ACME-4', title: 'Created draft' }), expect.any(Object))
    alert.mockRestore()
  })

  it('explains when no project is available', () => {
    mockUseProjects.mockReturnValue({ data: [] })

    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )

    expect(screen.getByText('No projects are attached yet. Add a project before creating a ticket.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Ticket' })).toBeDisabled()
  })

  /**
   * The form starts out inheriting, and used to resolve that to a boolean on the way
   * out — so every new ticket was frozen at whatever the project or profile said the
   * moment it was created, and a later change to either never reached it. The
   * AI-question fields beside it always sent the tri-state.
   */
  describe('the Manual QA setting on a new ticket', () => {
    function createTicket() {
      renderWithProviders(
        <UIContext.Provider value={makeUIValue()}>
          <TicketForm onClose={vi.fn()} />
        </UIContext.Provider>,
      )
      fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Verify checkout' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
      return mockUseCreateTicket().mutate.mock.calls[0]?.[0] as { manualQaOverride: boolean | null }
    }

    it('keeps inheriting when the user does not choose', () => {
      expect(createTicket().manualQaOverride).toBeNull()
    })

    it('sends the explicit choice when the user makes one', () => {
      renderWithProviders(
        <UIContext.Provider value={makeUIValue()}>
          <TicketForm onClose={vi.fn()} />
        </UIContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
      fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }))
      fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Verify checkout' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))

      expect(mockUseCreateTicket().mutate).toHaveBeenCalledWith(
        expect.objectContaining({ manualQaOverride: false }),
        expect.any(Object),
      )
    })
  })
})
