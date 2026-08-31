import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../AppShell'
import { UIContext, type UIContextValue } from '@/context/uiContextDef'
import { createTestQueryClient, renderWithProviders } from '@/test/renderHelpers'
import { TEST } from '@/test/factories'
import type { Project } from '@/hooks/useProjects'
import type { QueryClient } from '@tanstack/react-query'

vi.mock('@/hooks/useBackendHealth', () => ({
  useBackendHealth: vi.fn(() => ({ isOffline: false })),
}))

const useRecoveryAutoReloadMock = vi.hoisted(() => vi.fn())
const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseUpdateStatus = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useRecoveryAutoReload', () => ({
  useRecoveryAutoReload: useRecoveryAutoReloadMock,
}))

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => mockUseProjects(),
}))

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => mockUseUpdateStatus(),
}))

import { useBackendHealth } from '@/hooks/useBackendHealth'

const projects: Project[] = [
  {
    id: 1,
    name: 'Lumen Console',
    shortname: TEST.shortname,
    icon: 'L',
    color: '#2563eb',
    folderPath: '/tmp/lumen-console',
    profileId: null,
    councilMembers: null,
    maxIterations: null,
    perIterationTimeout: null,
    executionSetupTimeout: null,
    gitHookPolicy: null,
    ignoreMode: 'local',
    councilResponseTimeout: null,
    minCouncilQuorum: null,
    interviewQuestions: null,
    ticketCounter: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'Ledger Tools',
    shortname: TEST.shortnameB,
    icon: 'L',
    color: '#16a34a',
    folderPath: '/tmp/ledger',
    profileId: null,
    councilMembers: null,
    maxIterations: null,
    perIterationTimeout: null,
    executionSetupTimeout: null,
    gitHookPolicy: null,
    ignoreMode: 'local',
    councilResponseTimeout: null,
    minCouncilQuorum: null,
    interviewQuestions: null,
    ticketCounter: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 3,
    name: 'Acme Console',
    shortname: TEST.shortnameC,
    icon: 'A',
    color: '#f97316',
    folderPath: '/tmp/acme',
    profileId: null,
    councilMembers: null,
    maxIterations: null,
    perIterationTimeout: null,
    executionSetupTimeout: null,
    gitHookPolicy: null,
    ignoreMode: 'local',
    councilResponseTimeout: null,
    minCouncilQuorum: null,
    interviewQuestions: null,
    ticketCounter: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

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

function makeUIValue(overrides: Partial<UIContextValue['state']> = {}, dispatch = vi.fn()): UIContextValue {
  return {
    state: {
      selectedTicketId: null,
      selectedTicketExternalId: null,
      sidebarOpen: true,
      activeView: 'kanban',
      logPanelHeight: 300,
      filters: makeFilters(),
      presetsByProject: {},
      theme: 'system',
      showTriageBar: false,
      ...overrides,
    },
    dispatch,
  }
}

function renderShell(uiValue = makeUIValue(), onOpenAbout?: () => void, queryClient?: QueryClient) {
  return renderWithProviders(
    <UIContext.Provider value={uiValue}>
      <AppShell onOpenAbout={onOpenAbout}>
        <div>Dashboard</div>
      </AppShell>
    </UIContext.Provider>,
    queryClient ? { queryClient } : undefined,
  )
}

const uiValue: UIContextValue = makeUIValue({
  filters: makeFilters(),
})

describe('AppShell', () => {
  beforeEach(() => {
    useRecoveryAutoReloadMock.mockReset()
    mockUseProjects.mockReturnValue({ data: projects })
    mockUseUpdateStatus.mockReturnValue({ data: undefined })
  })

  it('renders a docs link that opens in a new tab', () => {
    renderShell(uiValue)

    const docsLink = screen.getByRole('link', { name: /docs/i })
    expect(docsLink).toHaveAttribute('href', `${__LOOPTROOP_DOCS_ORIGIN__}/`)
    expect(docsLink).toHaveAttribute('target', '_blank')
    expect(docsLink).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('shows a subtle update indicator and opens About from the version', () => {
    const onOpenAbout = vi.fn()
    mockUseUpdateStatus.mockReturnValue({
      data: { updateAvailable: true, latestVersion: '0.6.0' },
    })

    renderShell(uiValue, onOpenAbout)

    const versionButton = screen.getByRole('button', { name: /update 0\.6\.0 available; open about/i })
    expect(within(versionButton).getByTestId('update-available-icon')).toBeInTheDocument()
    fireEvent.click(versionButton)
    expect(onOpenAbout).toHaveBeenCalledOnce()
  })

  it('collapses secondary navigation without overflowing phone and tablet headers', () => {
    renderShell(uiValue)

    expect(screen.getByText('LoopTroop').parentElement).toHaveClass('hidden', 'sm:flex')
    expect(screen.getByRole('button', { name: 'More navigation actions' })).toHaveClass('lg:hidden')
    expect(screen.getByText('Projects').closest('button')).toHaveClass('hidden', 'lg:inline-flex')
    expect(screen.getByText('Configuration').closest('button')).toHaveClass('hidden', 'lg:inline-flex')
    expect(screen.getByRole('button', { name: 'Refresh Dashboard' })).toHaveClass('hidden', 'lg:inline-flex')
  })

  it('dispatches search filter updates immediately as the user types', () => {
    const dispatch = vi.fn()

    renderShell(makeUIValue({}, dispatch))

    fireEvent.change(screen.getByRole('searchbox', { name: /search tickets/i }), {
      target: { value: 'LOO-15' },
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_FILTER',
      filter: { search: 'LOO-15' },
    })
  })

  it('clears the dashboard search from the input icon slot', () => {
    const dispatch = vi.fn()

    renderShell(makeUIValue({
      filters: makeFilters('Loop'),
    }, dispatch))

    fireEvent.click(screen.getByRole('button', { name: /clear ticket search/i }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_FILTER',
      filter: { search: '' },
    })
  })

  it('clears the focused dashboard search with Escape', () => {
    const dispatch = vi.fn()

    renderShell(makeUIValue({
      filters: makeFilters('Loop'),
    }, dispatch))

    fireEvent.keyDown(screen.getByRole('searchbox', { name: /search tickets/i }), { key: 'Escape' })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_FILTER',
      filter: { search: '' },
    })
  })

  it('shows a count badge on the filter button when hidden triage filters are active', () => {
    renderShell(makeUIValue({
      filters: {
        ...makeFilters('visible-search-does-not-count'),
        priority: [1, 2],
        stuckDays: 3,
        errorState: 'blocked',
        sortBy: 'priority_asc',
      },
    }))

    const filterButton = screen.getByRole('button', { name: /show filters, 4 active/i })

    expect(within(filterButton).getByText('4')).toBeInTheDocument()
  })

  it('shows a count badge on the filter button when showMocks is false (mocks hidden)', () => {
    renderShell(makeUIValue({
      filters: {
        ...makeFilters('visible-search-does-not-count'),
        showMocks: false,
      },
    }))

    const filterButton = screen.getByRole('button', { name: /show filters, 1 active/i })

    expect(within(filterButton).getByText('1')).toBeInTheDocument()
  })

  it('suggests only project names that start with the typed search', () => {
    const dispatch = vi.fn()

    renderShell(makeUIValue({
      filters: makeFilters('l'),
    }, dispatch))

    fireEvent.focus(screen.getByRole('searchbox', { name: /search tickets/i }))

    expect(screen.getByRole('option', { name: 'Lumen Console' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Ledger Tools' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Acme Console' })).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Lumen Console' }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_FILTER',
      filter: { search: 'Lumen Console' },
    })
  })

  it('does not show the reconnecting banner or arm a reload when backend is reachable', () => {
    vi.mocked(useBackendHealth).mockReturnValue({ isOffline: false })

    renderShell(uiValue)

    expect(screen.queryByTestId('backend-reconnecting-banner')).not.toBeInTheDocument()
    expect(useRecoveryAutoReloadMock).not.toHaveBeenCalled()
  })

  it('shows the reconnecting banner without arming a destructive reload when backend is unreachable', () => {
    vi.mocked(useBackendHealth).mockReturnValue({ isOffline: true })

    renderShell(uiValue)

    expect(screen.getByTestId('backend-reconnecting-banner')).toBeInTheDocument()
    expect(screen.getByText(/reconnecting to server/i)).toBeInTheDocument()
    expect(useRecoveryAutoReloadMock).not.toHaveBeenCalled()
  })

  /**
   * The spinner used to be turned on before the refetch and off after it, with
   * nothing in between: a refetch that threw left it spinning for the rest of the
   * session, which reads as "still working" rather than "that failed".
   */
  it('stops the refresh spinner when the refetch fails', async () => {
    const queryClient = createTestQueryClient()
    vi.spyOn(queryClient, 'refetchQueries').mockRejectedValue(new Error('offline'))
    renderShell(uiValue, undefined, queryClient)

    const refresh = screen.getByRole('button', { name: 'Refresh Dashboard' })
    await act(async () => {
      fireEvent.click(refresh)
    })

    expect(queryClient.refetchQueries).toHaveBeenCalled()
    await waitFor(() => {
      expect(refresh).not.toBeDisabled()
    })
    expect(refresh.querySelector('.animate-spin')).toBeNull()
  })
})
