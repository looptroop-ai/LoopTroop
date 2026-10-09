import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { renderWithProviders } from '@/test/renderHelpers'
import { TicketForm } from '../TicketForm'
import type { Ticket } from '@/hooks/useTickets'

const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseProfile = vi.hoisted(() => vi.fn())
const mockUseCreateTicket = vi.hoisted(() => vi.fn())
const mockUseUpdateTicket = vi.hoisted(() => vi.fn())
const mockUseTicketAction = vi.hoisted(() => vi.fn())
const mockAddToast = vi.hoisted(() => vi.fn())

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
    mockUseProfile.mockReturnValue({
      data: { manualQaEnabled: false, gitHookPolicy: 'validate_advisory', aiQuestionsEnabled: true, aiQuestionWindow: 300_000 },
    })
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
        aiQuestionsOverride: null,
        aiQuestionWindowOverride: null,
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

  it('shows AI question settings and adjacent documentation only inside expanded Advanced', () => {
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )
    const advancedButton = screen.getByRole('button', { name: /Advanced/ })
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('AI questions')).not.toBeInTheDocument()
    expect(screen.queryByText('AI question wait')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'AI questions setting' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'AI question wait source' })).not.toBeInTheDocument()

    fireEvent.click(advancedButton)
    const advanced = within(advancedButton.parentElement!)
    for (const [label, path] of [
      ['AI questions', '/configuration#ai-questions'],
      ['AI question wait', '/configuration#ai-question-wait'],
    ] as const) {
      const help = advanced.getByRole('link', { name: `Open documentation for ticket ${label}` })
      expect(help).toHaveAttribute('href', `${__LOOPTROOP_DOCS_ORIGIN__}${path}`)
      expect(advanced.getByText(label)).toBe(screen.getByText(label))
      expect(advanced.getByText(label).parentElement).toContainElement(help)
    }
    const waitRow = advanced.getByText('AI question wait').closest('.pl-4')
    expect(waitRow).toHaveClass('pl-4')
    expect(waitRow).not.toHaveClass('border-t')
    expect(waitRow?.previousElementSibling).toContainElement(advanced.getByRole('radiogroup', { name: 'AI questions setting' }))

    fireEvent.click(advancedButton)
    expect(screen.queryByText('AI questions')).not.toBeInTheDocument()
    expect(screen.queryByText('AI question wait')).not.toBeInTheDocument()
  })

  it.each([
    { globalEnabled: true, questionsOverride: false, waitOverride: 720_000, questionsSource: 'Project', waitSource: 'Project', enabled: 'Off', minutes: 12 },
    { globalEnabled: true, questionsOverride: null, waitOverride: null, questionsSource: 'Configuration', waitSource: 'Configuration', enabled: 'On', minutes: 9 },
    { globalEnabled: true, questionsOverride: false, waitOverride: null, questionsSource: 'Project', waitSource: 'Configuration', enabled: 'Off', minutes: 9 },
    { globalEnabled: true, questionsOverride: null, waitOverride: 720_000, questionsSource: 'Configuration', waitSource: 'Project', enabled: 'On', minutes: 12 },
    { globalEnabled: false, questionsOverride: null, waitOverride: null, questionsSource: 'Configuration', waitSource: 'Configuration', enabled: 'Off', minutes: 9 },
  ])('inherits $enabled questions from $questionsSource and wait from $waitSource without freezing either value', ({ globalEnabled, questionsOverride, waitOverride, questionsSource, waitSource, enabled, minutes }) => {
    mockUseProfile.mockReturnValue({ data: { aiQuestionsEnabled: globalEnabled, aiQuestionWindow: 540_000 } })
    mockUseProjects.mockReturnValue({
      data: [{ ...mockUseProjects().data[0], aiQuestionsOverride: questionsOverride, aiQuestionWindowOverride: waitOverride }],
    })
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))

    const questions = screen.getByRole('radiogroup', { name: 'AI questions setting' })
    expect(within(questions).getByRole('radio', { name: 'Inherit' })).toHaveAttribute('aria-checked', 'true')
    expect(questions.parentElement).toHaveTextContent(`Inherits ${enabled} from ${questionsSource}.`)
    expect(screen.getByRole('radio', { name: 'Inherit ai question wait' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(`${minutes} minutes`).parentElement).toHaveTextContent(`${minutes} minutes from ${waitSource}`)
    const modes = within(screen.getByRole('radiogroup', { name: 'AI question wait source' })).getAllByRole('radio')
    if (enabled === 'Off') {
      for (const mode of modes) expect(mode).toBeDisabled()
      fireEvent.click(within(questions).getByRole('radio', { name: 'On' }))
      for (const mode of modes) expect(mode).toBeEnabled()
      expect(screen.getByRole('radio', { name: 'Inherit ai question wait' })).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByText(`${minutes} minutes`)).toBeInTheDocument()
      fireEvent.click(within(questions).getByRole('radio', { name: 'Inherit' }))
      for (const mode of modes) expect(mode).toBeDisabled()
    } else {
      for (const mode of modes) expect(mode).toBeEnabled()
    }

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Inherited settings' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
    expect(mockUseCreateTicket().mutate).toHaveBeenCalledWith(
      expect.objectContaining({ aiQuestionsOverride: null, aiQuestionWindowOverride: null }),
      expect.any(Object),
    )
  })

  it('seeds Custom from the effective project wait and creates a ticket with milliseconds', () => {
    mockUseProjects.mockReturnValue({
      data: [{ ...mockUseProjects().data[0], aiQuestionWindowOverride: 720_000 }],
    })
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    const wait = screen.getByLabelText('AI question wait')
    expect(wait).toHaveValue(12)
    expect(screen.queryByRole('button', { name: 'Clear override' })).not.toBeInTheDocument()

    fireEvent.change(wait, { target: { value: '7' } })
    const questions = within(screen.getByRole('radiogroup', { name: 'AI questions setting' }))
    const modes = within(screen.getByRole('radiogroup', { name: 'AI question wait source' })).getAllByRole('radio')
    fireEvent.click(questions.getByRole('radio', { name: 'Off' }))
    for (const mode of modes) expect(mode).toBeDisabled()
    expect(wait).toBeDisabled()
    expect(wait).toHaveValue(7)
    expect(screen.getByRole('radio', { name: 'Set a custom ai question wait' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(questions.getByRole('radio', { name: 'On' }))
    for (const mode of modes) expect(mode).toBeEnabled()
    expect(wait).toBeEnabled()
    expect(wait).toHaveValue(7)
    fireEvent.click(questions.getByRole('radio', { name: 'Off' }))
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Custom settings' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))

    expect(mockUseCreateTicket().mutate).toHaveBeenCalledWith(
      expect.objectContaining({ aiQuestionsOverride: false, aiQuestionWindowOverride: 420_000 }),
      expect.any(Object),
    )
  })

  it('blocks create and start for active invalid waits, suspends errors while Off, and resets with Inherit', () => {
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Validate wait' } })
    const create = screen.getByRole('button', { name: 'Create Ticket' })
    const start = screen.getByRole('button', { name: 'Create & Start' })
    expect(create).toBeEnabled()
    expect(start).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    const wait = screen.getByLabelText('AI question wait')
    fireEvent.change(wait, { target: { value: '2.5' } })

    expect(wait).toHaveValue(2.5)
    expect(wait).toHaveAttribute('aria-invalid', 'true')
    expect(create).toBeDisabled()
    expect(start).toBeDisabled()
    fireEvent.click(create)
    fireEvent.click(start)
    fireEvent.submit(create.closest('form')!)
    expect(mockUseCreateTicket().mutate).not.toHaveBeenCalled()
    expect(mockUseCreateTicket().mutateAsync).not.toHaveBeenCalled()
    expect(mockUseTicketAction().mutateAsync).not.toHaveBeenCalled()

    const questions = within(screen.getByRole('radiogroup', { name: 'AI questions setting' }))
    fireEvent.click(questions.getByRole('radio', { name: 'Off' }))
    expect(wait).toBeDisabled()
    expect(wait).toHaveValue(2.5)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(create).toBeEnabled()
    expect(start).toBeEnabled()
    fireEvent.click(create)
    expect(mockUseCreateTicket().mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ aiQuestionsOverride: false, aiQuestionWindowOverride: 300_000 }),
      expect.any(Object),
    )

    fireEvent.click(questions.getByRole('radio', { name: 'On' }))
    expect(wait).toBeEnabled()
    expect(wait).toHaveValue(2.5)
    expect(wait).toHaveAttribute('aria-invalid', 'true')
    expect(create).toBeDisabled()
    expect(start).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Inherit ai question wait' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(create).toBeEnabled()
    expect(start).toBeEnabled()
    fireEvent.click(create)
    expect(mockUseCreateTicket().mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ aiQuestionWindowOverride: null }),
      expect.any(Object),
    )
  })

  it('blocks saving an edited draft until its custom wait is valid', () => {
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={vi.fn()} />
      </UIContext.Provider>,
    )
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Created draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))
    const options = mockUseCreateTicket().mutate.mock.calls[0]?.[1] as { onSuccess: (ticket: Ticket) => void }
    act(() => options.onSuccess({ id: '1:ACME-5', status: 'DRAFT' } as Ticket))

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    const wait = screen.getByLabelText('AI question wait')
    fireEvent.change(wait, { target: { value: '0' } })
    const save = screen.getByRole('button', { name: 'Save Ticket' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(mockUseUpdateTicket().mutate).not.toHaveBeenCalled()

    const questions = within(screen.getByRole('radiogroup', { name: 'AI questions setting' }))
    fireEvent.click(questions.getByRole('radio', { name: 'Off' }))
    expect(wait).toBeDisabled()
    expect(wait).toHaveValue(0)
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(mockUseUpdateTicket().mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ aiQuestionsOverride: false, aiQuestionWindowOverride: 300_000 }),
      expect.any(Object),
    )

    fireEvent.click(questions.getByRole('radio', { name: 'On' }))
    expect(wait).toHaveValue(0)
    expect(wait).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()
    fireEvent.change(wait, { target: { value: '12' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(mockUseUpdateTicket().mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: '1:ACME-5', aiQuestionWindowOverride: 720_000 }),
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

  it('confirms before Cancel discards a dirty ticket draft', () => {
    const onClose = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderWithProviders(
      <UIContext.Provider value={makeUIValue()}>
        <TicketForm onClose={onClose} />
      </UIContext.Provider>,
    )

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Unsaved ticket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved ticket changes?')
    expect(onClose).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })

  it('saves supported edits by ID after create-and-start without sending locked settings', async () => {
    let resolveCreate!: (ticket: Ticket) => void
    let resolveStart!: (result: { status: string }) => void
    const createPromise = new Promise<Ticket>((resolve) => { resolveCreate = resolve })
    const startPromise = new Promise<{ status: string }>((resolve) => { resolveStart = resolve })
    const update = vi.fn()
    const ui = makeUIValue()
    mockUseCreateTicket.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(() => createPromise), isPending: false })
    mockUseUpdateTicket.mockReturnValue({ mutate: update, isPending: false })
    mockUseTicketAction.mockReturnValue({ mutateAsync: vi.fn(() => startPromise), isPending: false })

    renderWithProviders(
      <UIContext.Provider value={ui}>
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

    const updated = { id: '1:ACME-3', externalId: 'ACME-3', status: 'IN_PROGRESS' } as Ticket
    act(() => (update.mock.calls[0]?.[1] as { onSuccess: (ticket: Ticket) => void }).onSuccess(updated))
    expect(ui.dispatch).toHaveBeenCalledWith({
      type: 'SELECT_TICKET',
      ticketId: updated.id,
      externalId: updated.externalId,
    })

    vi.mocked(ui.dispatch).mockClear()
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Save in flight' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Ticket' }))
    fireEvent.change(screen.getByPlaceholderText('Brief summary of the work'), { target: { value: 'Typed after save' } })
    act(() => (update.mock.calls[1]?.[1] as { onSuccess: (ticket: Ticket) => void }).onSuccess(updated))
    expect(ui.dispatch).not.toHaveBeenCalled()
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
