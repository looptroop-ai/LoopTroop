import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { renderWithProviders } from '@/test/renderHelpers'
import { TicketForm } from '../TicketForm'

const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseCreateTicket = vi.hoisted(() => vi.fn())
const mockUseTicketAction = vi.hoisted(() => vi.fn())
const mockAddToast = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockUseProjects(),
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { manualQaEnabled: false, gitHookPolicy: 'validate_explicitly' } }),
}))

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useCreateTicket: () => mockUseCreateTicket(),
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
        gitHookPolicy: 'ignore_internal_only',
        ticketCounter: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    mockUseCreateTicket.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
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
    expect(screen.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Effective setting:/)).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Ignore' })).toHaveAttribute('aria-checked', 'true')
    const helpLink = screen.getByRole('link', { name: 'Open documentation for ticket Manual QA checkpoint' })
    expect(helpLink).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    fireEvent.focus(helpLink)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Choose whether this ticket pauses for your verification after final tests.')
    expect(screen.getByRole('link', { name: 'Open documentation for ticket Git hook policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#git-hook-policy`,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Verify checkout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
    expect(mockUseCreateTicket().mutate).toHaveBeenCalledWith(
      expect.objectContaining({ manualQaOverride: true, gitHookPolicy: 'ignore_internal_only' }),
      expect.any(Object),
    )
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

    expect(mockAddToast).toHaveBeenCalledWith('error', 'Project is unavailable', 5000)
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
})
