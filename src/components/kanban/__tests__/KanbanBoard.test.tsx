import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { UIProvider } from '@/context/UIContext'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { KanbanBoard } from '../KanbanBoard'
import { renderWithProviders as sharedRenderWithProviders } from '@/test/renderHelpers'
import { TEST, makeTicket } from '@/test/factories'
import { ticketCardLabel } from '@/test/ticketCardQueries'
import type { Ticket } from '@/hooks/useTickets'
import type { Project } from '@/hooks/useProjects'

const mockUseTickets = vi.hoisted(() => vi.fn())
const mockUseProjects = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useTickets', () => ({
  useTickets: () => mockUseTickets(),
}))

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockUseProjects(),
}))

function renderWithProviders(ui: React.ReactElement) {
  return sharedRenderWithProviders(<UIProvider>{ui}</UIProvider>)
}

function makeFilters(search = ''): UIContextValue['state']['filters'] {
  return {
    projectId: null,
    status: null,
    phase: null,
    search,
    priority: null,
    stuckDays: null,
    errorState: 'none',
    sortBy: 'updatedAt_desc',
    showMocks: true,
  }
}

function makeUIValue(
  search: string,
  dispatch = vi.fn(),
  filterOverrides: Partial<UIContextValue['state']['filters']> = {},
): UIContextValue {
  return {
    state: {
      selectedTicketId: null,
      selectedTicketExternalId: null,
      sidebarOpen: true,
      activeView: 'kanban',
      logPanelHeight: 300,
      filters: { ...makeFilters(search), ...filterOverrides },
      presetsByProject: {},
      theme: 'system',
      showTriageBar: false,
    },
    dispatch,
  }
}

function renderWithSearch(search: string, dispatch = vi.fn()) {
  return sharedRenderWithProviders(
    <UIContext.Provider value={makeUIValue(search, dispatch)}>
      <KanbanBoard />
    </UIContext.Provider>,
  )
}

function renderWithFilters(filterOverrides: Partial<UIContextValue['state']['filters']>, dispatch = vi.fn()) {
  return sharedRenderWithProviders(
    <UIContext.Provider value={makeUIValue(filterOverrides.search ?? '', dispatch, filterOverrides)}>
      <KanbanBoard />
    </UIContext.Provider>,
  )
}

/** The filter bar, and with it the Reset button, only exists while triage is open. */
function renderTriageBar(filterOverrides: Partial<UIContextValue['state']['filters']>, dispatch = vi.fn()) {
  const uiValue = makeUIValue(filterOverrides.search ?? '', dispatch, filterOverrides)
  uiValue.state.showTriageBar = true
  return sharedRenderWithProviders(
    <UIContext.Provider value={uiValue}>
      <KanbanBoard />
    </UIContext.Provider>,
  )
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: TEST.projectId,
    name: 'Test Project',
    shortname: TEST.shortname,
    icon: 'T',
    color: '#2563eb',
    folderPath: '/tmp/test-project',
    profileId: null,
    councilMembers: null,
    maxIterations: null,
    perIterationTimeout: null,
    executionSetupTimeout: null,
    councilResponseTimeout: null,
    minCouncilQuorum: null,
    interviewQuestions: null,
    ticketCounter: 1,
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
    ...overrides,
    gitHookPolicy: overrides.gitHookPolicy ?? null,
    ignoreMode: overrides.ignoreMode ?? 'local',
  }
}

function mockBoardData(tickets: Ticket[], projects: Project[]) {
  mockUseTickets.mockReturnValue({ data: tickets, isLoading: false })
  mockUseProjects.mockReturnValue({ data: projects })
}

describe('KanbanBoard', () => {
  beforeEach(() => {
    localStorage.clear()
    mockBoardData([], [])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A backend that is not answering used to render as the "fetching the
   * tickets" banner, forever and without a single mention of failure, so an
   * unreachable daemon was indistinguishable from a slow one.
   */
  describe('when the tickets query fails', () => {
    const failure = new Error('Failed to fetch tickets (HTTP 503: API token not configured)')

    function mockFailedTickets(overrides: Record<string, unknown> = {}) {
      mockUseTickets.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: failure,
        refetch: vi.fn(),
        isFetching: false,
        ...overrides,
      })
      mockUseProjects.mockReturnValue({ data: [] })
    }

    it('says the tickets could not be loaded instead of claiming to load them', () => {
      mockFailedTickets()
      renderWithProviders(<KanbanBoard />)

      expect(screen.getByRole('alert')).toHaveTextContent('Tickets unavailable')
      expect(screen.queryByText(/LoopTroop is fetching the tickets/)).not.toBeInTheDocument()
    })

    it('quotes the reason, so the status code is visible without devtools', () => {
      mockFailedTickets()
      renderWithProviders(<KanbanBoard />)

      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 503: API token not configured')
    })

    it('reassures that nothing was deleted, because an empty board reads as data loss', () => {
      mockFailedTickets()
      renderWithProviders(<KanbanBoard />)

      expect(screen.getByRole('alert')).toHaveTextContent('Your tickets are not lost')
    })

    it('refetches when the retry button is used', () => {
      const refetch = vi.fn()
      mockFailedTickets({ refetch })
      renderWithProviders(<KanbanBoard />)

      fireEvent.click(screen.getByRole('button', { name: /retry/i }))

      expect(refetch).toHaveBeenCalledTimes(1)
    })

    it('disables the retry button while a retry is already in flight', () => {
      mockFailedTickets({ isFetching: true })
      renderWithProviders(<KanbanBoard />)

      expect(screen.getByRole('button', { name: /retrying/i })).toBeDisabled()
    })

    it('still shows the loading banner for a genuinely pending first load', () => {
      mockUseTickets.mockReturnValue({ data: undefined, isLoading: true, isError: false })
      mockUseProjects.mockReturnValue({ data: [] })
      renderWithProviders(<KanbanBoard />)

      expect(screen.getByText(/LoopTroop is fetching the tickets/)).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('renders 4 columns', () => {
    const { container } = renderWithProviders(<KanbanBoard />)
    const todo = screen.getByText('To Do')
    const needsInput = screen.getByText('Needs Input')
    const inProgress = screen.getByText('In Progress')
    const done = screen.getByText('Done')

    expect(todo).toBeInTheDocument()
    expect(needsInput).toBeInTheDocument()
    expect(inProgress).toBeInTheDocument()
    expect(done).toBeInTheDocument()
    expect(todo.compareDocumentPosition(needsInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(needsInput.compareDocumentPosition(inProgress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(inProgress.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('.grid.flex-1')).toHaveClass('overflow-y-auto', 'lg:overflow-hidden')
    expect(container.querySelector('.grid.flex-1')).not.toHaveClass('md:overflow-hidden')
  })

  it('shows "No tickets" in empty columns', () => {
    renderWithProviders(<KanbanBoard />)
    const noTickets = screen.getAllByText('No tickets')
    expect(noTickets.length).toBe(4)
  })

  it('shows correct column descriptions', () => {
    renderWithProviders(<KanbanBoard />)
    expect(screen.getByText('Backlog')).toBeInTheDocument()
    expect(screen.getByText('Active workflow')).toBeInTheDocument()
    expect(screen.getByText('Waiting for user')).toBeInTheDocument()
    expect(screen.getByText('Completed tickets')).toBeInTheDocument()
  })

  it('filters rendered tickets and column counts by ticket ID compact matching', () => {
    const primaryProject = makeProject({ id: 1, name: 'Search Project', shortname: TEST.shortname })
    const secondaryProject = makeProject({ id: 2, name: 'Other Project', shortname: TEST.shortnameB })
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-15`,
        externalId: `${TEST.shortname}-15`,
        title: 'Visible ticket',
        description: 'Description text is also searchable.',
        status: 'DRAFT',
        projectId: primaryProject.id,
      }),
      makeTicket({
        id: `1:${TEST.shortname}-16`,
        externalId: `${TEST.shortname}-16`,
        title: 'Other ticket',
        description: `This other ticket description does not contain the query.`,
        status: 'CODING',
        projectId: secondaryProject.id,
      }),
    ], [primaryProject, secondaryProject])

    renderWithSearch(`${TEST.shortname}15`)

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-15`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-16`))).not.toBeInTheDocument()
    expect(within(screen.getByText('To Do').parentElement as HTMLElement).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByText('In Progress').parentElement as HTMLElement).getByText('0')).toBeInTheDocument()
    expect(screen.getAllByText('No matching tickets')).toHaveLength(3)
  })

  it('shows the matched search field hint on cards', () => {
    const primaryProject = makeProject({ id: 1, name: 'Search Project', shortname: TEST.shortname })
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-17`,
        externalId: `${TEST.shortname}-17`,
        title: 'Visible title',
        description: 'Hidden implementation detail',
        status: 'DRAFT',
        projectId: primaryProject.id,
      }),
    ], [primaryProject])

    renderWithSearch('hidden implementation')

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-17`))).toBeInTheDocument()
    expect(screen.getByText('Description match')).toBeInTheDocument()
  })

  it('limits stale filtering to Needs Input and In Progress columns', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z'))

    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-20`,
        externalId: `${TEST.shortname}-20`,
        title: 'Stale needs input',
        status: 'WAITING_PRD_APPROVAL',
        updatedAt: '2026-06-25T12:00:00.000Z',
      }),
      makeTicket({
        id: `1:${TEST.shortname}-21`,
        externalId: `${TEST.shortname}-21`,
        title: 'Stale in progress',
        status: 'CODING',
        updatedAt: '2026-06-25T12:00:00.000Z',
      }),
      makeTicket({
        id: `1:${TEST.shortname}-22`,
        externalId: `${TEST.shortname}-22`,
        title: 'Old draft',
        status: 'DRAFT',
        updatedAt: '2026-06-25T12:00:00.000Z',
      }),
      makeTicket({
        id: `1:${TEST.shortname}-23`,
        externalId: `${TEST.shortname}-23`,
        title: 'Old done',
        status: 'COMPLETED',
        updatedAt: '2026-06-25T12:00:00.000Z',
      }),
    ], [makeProject()])

    renderWithFilters({ stuckDays: 1 })

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-20`, 'waiting for your input'))).toBeInTheDocument()
    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-21`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-22`))).not.toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-23`))).not.toBeInTheDocument()
    expect(within(screen.getByText('To Do').parentElement as HTMLElement).getByText('0')).toBeInTheDocument()
    expect(within(screen.getByText('Needs Input').parentElement as HTMLElement).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByText('In Progress').parentElement as HTMLElement).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByText('Done').parentElement as HTMLElement).getByText('0')).toBeInTheDocument()
  })

  it('moves a working ticket with a pending question into Needs Input', () => {
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-24`,
        externalId: `${TEST.shortname}-24`,
        title: 'Asked a question',
        status: 'CODING',
        pendingQuestions: { requestCount: 1, questionCount: 2, deadlineAt: null, stoppedAt: null },
      }),
      makeTicket({
        id: `1:${TEST.shortname}-25`,
        externalId: `${TEST.shortname}-25`,
        title: 'Working quietly',
        status: 'CODING',
      }),
    ], [makeProject()])

    renderWithProviders(<KanbanBoard />)

    expect(within(screen.getByText('Needs Input').parentElement as HTMLElement).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByText('In Progress').parentElement as HTMLElement).getByText('1')).toBeInTheDocument()
  })

  it('filters tickets by selected workflow status', () => {
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-30`,
        externalId: `${TEST.shortname}-30`,
        title: 'Coding ticket',
        status: 'CODING',
        projectId: TEST.projectId,
      }),
      makeTicket({
        id: `1:${TEST.shortname}-31`,
        externalId: `${TEST.shortname}-31`,
        title: 'Draft ticket',
        status: 'DRAFT',
        projectId: TEST.projectId,
      }),
    ], [makeProject()])

    renderWithFilters({ status: ['CODING'] })

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-30`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-31`))).not.toBeInTheDocument()
  })

  it('filters tickets by selected workflow phase group', () => {
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-40`,
        externalId: `${TEST.shortname}-40`,
        title: 'PRD ticket',
        status: 'DRAFTING_PRD',
        projectId: TEST.projectId,
      }),
      makeTicket({
        id: `1:${TEST.shortname}-41`,
        externalId: `${TEST.shortname}-41`,
        title: 'Coding ticket',
        status: 'CODING',
        projectId: TEST.projectId,
      }),
    ], [makeProject()])

    renderWithFilters({ phase: ['prd'] })

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-40`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-41`))).not.toBeInTheDocument()
  })

  it('filters tickets with past errors when errorState is "past"', () => {
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-50`,
        externalId: `${TEST.shortname}-50`,
        title: 'Recovered ticket',
        status: 'CODING',
        hasPastErrors: true,
        projectId: TEST.projectId,
      }),
      makeTicket({
        id: `1:${TEST.shortname}-51`,
        externalId: `${TEST.shortname}-51`,
        title: 'Clean ticket',
        status: 'CODING',
        hasPastErrors: false,
        projectId: TEST.projectId,
      }),
    ], [makeProject()])

    renderWithFilters({ errorState: 'past' })

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-50`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-51`))).not.toBeInTheDocument()
  })

  it('filters tickets currently blocked when errorState is "blocked"', () => {
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-60`,
        externalId: `${TEST.shortname}-60`,
        title: 'Blocked ticket',
        status: 'BLOCKED_ERROR',
        projectId: TEST.projectId,
      }),
      makeTicket({
        id: `1:${TEST.shortname}-61`,
        externalId: `${TEST.shortname}-61`,
        title: 'Active ticket',
        status: 'CODING',
        projectId: TEST.projectId,
      }),
    ], [makeProject()])

    renderWithFilters({ errorState: 'blocked' })

    expect(screen.getByLabelText(ticketCardLabel(`${TEST.shortname}-60`))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel(`${TEST.shortname}-61`))).not.toBeInTheDocument()
  })

  it('shows saved preset details on hover', async () => {
    const uiValueWithTriageOpen = makeUIValue('')
    uiValueWithTriageOpen.state.showTriageBar = true
    uiValueWithTriageOpen.state.presetsByProject = {
      'looptroop-presets-global': {
        'Night ops': {
          priority: [1, 2],
          stuckDays: 3,
          status: null,
          phase: null,
          errorState: 'blocked',
          sortBy: 'priority_asc',
          showMocks: true,
        },
      },
    }

    sharedRenderWithProviders(
      <UIContext.Provider value={uiValueWithTriageOpen}>
        <KanbanBoard />
      </UIContext.Provider>,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.focus(await screen.findByRole('button', { name: 'Night ops' }))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Priority: Very High, High')
    expect(tooltip).toHaveTextContent('Stale: > 3 days inactive')
    expect(tooltip).toHaveTextContent('Errors: Currently blocked')
    expect(tooltip).toHaveTextContent('Sort: Priority (High to Low)')
  })

  it('saves a preset from the dropdown form and restores it after remount', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      activeView: 'kanban',
      sidebarOpen: true,
      logPanelHeight: 300,
      showTriageBar: true,
      filters: {
        projectId: null,
        status: null,
        phase: null,
        search: '',
        priority: [1],
        stuckDays: 3,
        errorState: 'blocked',
        sortBy: 'priority_asc',
      },
      presetsByProject: {},
      theme: 'system',
    }))

    const { unmount } = renderWithProviders(<KanbanBoard />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.change(screen.getByPlaceholderText('New preset...'), {
      target: { value: 'Night ops' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Saved "Night ops"')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Night ops' })).toBeInTheDocument()

    const stored = JSON.parse(localStorage.getItem('looptroop-ui-state') ?? '{}') as {
      presetsByProject?: Record<string, Record<string, unknown>>
    }
    expect(stored.presetsByProject?.['looptroop-presets-global']).toHaveProperty('Night ops')

    unmount()
    renderWithProviders(<KanbanBoard />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByRole('button', { name: 'Night ops' })).toBeInTheDocument()
  })

  it('restores project-scoped presets after remount', () => {
    mockBoardData([], [makeProject()])
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      activeView: 'kanban',
      sidebarOpen: true,
      logPanelHeight: 300,
      showTriageBar: true,
      filters: {
        projectId: TEST.projectId,
        status: null,
        phase: null,
        search: '',
        priority: [1],
        stuckDays: 3,
        errorState: 'blocked',
        sortBy: 'priority_asc',
      },
      presetsByProject: {},
      theme: 'system',
    }))

    const { unmount } = renderWithProviders(<KanbanBoard />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.change(screen.getByPlaceholderText('New preset...'), {
      target: { value: 'Project ops' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const projectPresetKey = `looptroop-presets-${TEST.projectId}`
    const stored = JSON.parse(localStorage.getItem('looptroop-ui-state') ?? '{}') as {
      presetsByProject?: Record<string, Record<string, unknown>>
    }
    expect(stored.presetsByProject?.[projectPresetKey]).toHaveProperty('Project ops')

    unmount()
    renderWithProviders(<KanbanBoard />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByRole('button', { name: 'Project ops' })).toBeInTheDocument()
  })

  it('shows a dashboard no-results state with a clear action', () => {
    const dispatch = vi.fn()
    mockBoardData([
      makeTicket({
        id: `1:${TEST.shortname}-18`,
        externalId: `${TEST.shortname}-18`,
        title: 'Visible ticket',
        status: 'DRAFT',
      }),
    ], [makeProject()])

    renderWithSearch('missing-ticket', dispatch)

    expect(screen.getByText('No tickets match this search.')).toBeInTheDocument()
    expect(screen.getAllByText('No matching tickets')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: /clear search/i }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_FILTER',
      filter: { search: '' },
    })
  })

  /**
   * Search and the mock-ticket toggle are filters like any other. Leaving them out of
   * Reset meant the button disappeared while the board was still filtered, and when it
   * was there, pressing it left the search in place — so "Reset" did not reset.
   */
  describe('the filter bar Reset button', () => {
    it('appears when only a search is active, and clears it', () => {
      const dispatch = vi.fn()
      mockBoardData([], [makeProject()])

      renderTriageBar({ search: 'anything' }, dispatch)

      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))

      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        type: 'SET_FILTER',
        filter: expect.objectContaining({ search: '' }),
      }))
    })

    it('appears when mock tickets are the only thing hidden', () => {
      mockBoardData([], [makeProject()])

      renderTriageBar({ showMocks: false })

      expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    })

    it('stays away when nothing is filtered', () => {
      mockBoardData([], [makeProject()])

      renderTriageBar({})

      expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
    })

    it('names the preset each delete control removes', () => {
      mockBoardData([], [makeProject()])
      localStorage.setItem('looptroop-ui-state', JSON.stringify({
        showTriageBar: true,
        filters: {},
        presetsByProject: {
          'looptroop-presets-global': {
            'Night ops': { priority: [1], stuckDays: 3, errorState: 'blocked', sortBy: 'priority_asc' },
          },
        },
      }))

      renderWithProviders(<KanbanBoard />)
      fireEvent.pointerDown(screen.getByRole('button', { name: /presets/i }), { button: 0, ctrlKey: false })

      expect(screen.getByRole('button', { name: 'Delete preset Night ops' })).toBeInTheDocument()
    })
  })
})
