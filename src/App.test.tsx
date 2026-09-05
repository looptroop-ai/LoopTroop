import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { UIProvider } from '@/context/UIContext'
import { useUI } from '@/context/useUI'
import { WELCOME_DISCLAIMER_STORAGE_KEY } from '@/components/shared/WelcomeDisclaimer'
import type { StartupStatus } from '@/hooks/useStartupStatus'

const mockState = vi.hoisted(() => ({
  startupStatus: null as StartupStatus | null,
  tickets: [] as Array<{ id: string; externalId: string }>,
  ticketsFetched: true,
  ticketsLoading: false,
  ticketsError: false,
  dismissMutation: {
    mutate: vi.fn(),
    isPending: false,
  },
}))

const MISSING_TICKET_EXTERNAL_ID = 'test-ticket-1'

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children, onNavigateHome, onOpenProfile }: {
    children: ReactNode
    onNavigateHome?: () => void
    onOpenProfile?: () => void
  }) => (
    <div data-testid="app-shell">
      {/* Stand-ins for the shell's navigation controls: the logo, and one of
          the four buttons that open a routed modal. */}
      <button type="button" onClick={onNavigateHome}>Logo</button>
      <button type="button" onClick={onOpenProfile}>Open Configuration</button>
      {children}
    </div>
  ),
}))

vi.mock('@/components/kanban/KanbanBoard', () => ({
  KanbanBoard: () => <div>Kanban Board</div>,
}))

vi.mock('@/components/ticket/TicketDashboard', () => ({
  TicketDashboard: () => <div>Ticket Dashboard</div>,
}))

vi.mock('@/components/shared/CenteredModal', () => ({
  CenteredModal: ({ open, children, onClose, title }: { open: boolean; children: ReactNode; onClose: () => void; title: string }) => (
    open
      ? (
        <div>
          <button type="button" onClick={onClose}>{`Close ${title}`}</button>
          {children}
        </div>
      )
      : null
  ),
}))

vi.mock('@/components/config/ProfileSetup', () => ({
  ProfileSetup: ({ onOpenAbout }: { onOpenAbout?: () => void }) => (
    <div>
      <div>Profile Setup</div>
      <button type="button" onClick={onOpenAbout}>Open About</button>
    </div>
  ),
}))

vi.mock('@/components/config/AboutDialog', () => ({
  AboutDialog: () => <div>About Dialog</div>,
}))

vi.mock('@/components/project/ProjectsPanel', () => ({
  ProjectsPanel: () => <div>Projects Panel</div>,
}))

vi.mock('@/components/ticket/TicketForm', () => ({
  TicketForm: () => <div>Ticket Form</div>,
}))

vi.mock('@/components/shared/KeyboardShortcuts', () => ({
  KeyboardShortcuts: () => null,
}))

vi.mock('@/hooks/useTickets', () => ({
  useTickets: () => ({
    data: mockState.tickets,
    isFetched: mockState.ticketsFetched,
    isLoading: mockState.ticketsLoading,
    // Mirrors TanStack: a query that errored is fetched and settled but not
    // successful. Deriving this from `ticketsFetched` alone made every
    // error-state test also assert the success path, and the URL hydration
    // reads exactly this flag.
    isSuccess: mockState.ticketsFetched && !mockState.ticketsLoading && !mockState.ticketsError,
    isError: mockState.ticketsError,
  }),
}))

/**
 * The workspace preloader imports a chunk. Under the test runner that resolves
 * after the test has finished and torn its environment down, which surfaces as
 * an unhandled rejection attributed to whichever test was unlucky. Nothing here
 * asserts on prefetching, so there is nothing to lose by stubbing it.
 */
vi.mock('@/components/ticket/workspacePreload', () => ({
  preloadWorkspaceForView: vi.fn(() => Promise.resolve()),
}))

const useRecoveryAutoReloadMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useRecoveryAutoReload', () => ({
  useRecoveryAutoReload: useRecoveryAutoReloadMock,
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: null }),
}))

vi.mock('@/hooks/useStartupStatus', () => ({
  useStartupStatus: () => ({ data: mockState.startupStatus }),
  useDismissStartupRestoreNotice: () => mockState.dismissMutation,
}))

function makeStartupStatus(overrides: Partial<StartupStatus['storage']> = {}): StartupStatus {
  return {
    storage: {
      kind: 'restored',
      dbPath: '/home/liviu/.config/looptroop/app.sqlite',
      configDir: '/home/liviu/.config/looptroop',
      source: 'default',
      profileRestored: true,
      restoredProjectCount: 1,
      restoredProjects: [
        {
          name: 'Restored Project',
          shortname: 'RST',
          folderPath: '/home/liviu/RestoredProject',
        },
      ],
      ...overrides,
    },
    runtime: {
      isWsl: false,
      osLabel: 'Linux',
      appRoot: '/home/liviu/LoopTroop',
      appPathWarning: null,
    },
    ui: {
      restoreNotice: {
        shouldShow: true,
        dismissedAt: null,
      },
    },
  }
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  })
}

function renderAppElement(queryClient: QueryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <App />
      </UIProvider>
    </QueryClientProvider>,
  )
}

function renderApp() {
  return renderAppElement()
}

/** Drives the selection from outside `App`, the way the board and the shell do. */
function SelectionProbe() {
  const { dispatch } = useUI()
  return (
    <>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SELECT_TICKET', ticketId: 'ticket-1', externalId: 'LT-1' })}
      >
        Select LT-1
      </button>
      <button type="button" onClick={() => dispatch({ type: 'CLOSE_TICKET' })}>Close ticket</button>
    </>
  )
}

function renderAppWithProbe(queryClient: QueryClient = createTestQueryClient()) {
  // A fresh element each time: React bails out of a re-render given the very
  // same element object, so a reused one would silently skip the update the
  // test is trying to make.
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <App />
        <SelectionProbe />
      </UIProvider>
    </QueryClientProvider>
  )
  const result = render(tree())
  return { ...result, rerenderApp: () => result.rerender(tree()) }
}

/** Re-renders `App` after the mocked ticket query has been moved on. */
function rerenderAppElement(rerender: (ui: ReactNode) => void, queryClient: QueryClient) {
  rerender(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <App />
      </UIProvider>
    </QueryClientProvider>,
  )
}

function persistTicketSelection(ticketId: string, externalId: string) {
  localStorage.setItem('looptroop-ui-state', JSON.stringify({
    selectedTicketId: ticketId,
    selectedTicketExternalId: externalId,
    activeView: 'ticket',
    sidebarOpen: true,
    logPanelHeight: 300,
    filters: { projectId: null, status: null, search: '' },
    theme: 'system',
  }))
}

/**
 * `App` is the only writer of `window.history`. These lock that down: the URL
 * used to have two owners, and `UIContext`'s mount effect rewrote the pathname
 * of whatever route `App` had just opened.
 */
describe('App route ownership', () => {
  beforeEach(() => {
    mockState.tickets = []
    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    mockState.ticketsError = false
    mockState.startupStatus = null
    useRecoveryAutoReloadMock.mockReset()
    localStorage.clear()
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    window.history.pushState(null, '', '/')
  })

  // The history spies below would otherwise outlive their test: nothing in this
  // project restores spies automatically, and a leaked one turns the next test's
  // navigation into a recording of the previous test's expectations.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the modal route when a ticket selection is restored underneath it', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Ticket Dashboard')).toBeInTheDocument()
    })
    expect(window.location.pathname).toBe('/config')
  })

  it('restores the ticket route when the modal opened over it closes', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close Configuration' }))

    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })
  })

  /**
   * The ticket list is still in flight when the app mounts, which is the case
   * that matters: a route effect that writes before the deep link has been
   * resolved pushes the *restored* ticket over the *requested* one, and the
   * hydration step then reads back the pathname it just clobbered.
   */
  it('honours a deep-linked ticket over the restored selection without rewriting the URL', async () => {
    persistTicketSelection('ticket-2', 'LT-2')
    mockState.tickets = [
      { id: 'ticket-1', externalId: 'LT-1' },
      { id: 'ticket-2', externalId: 'LT-2' },
    ]
    mockState.ticketsFetched = false
    mockState.ticketsLoading = true
    window.history.pushState(null, '', '/ticket/LT-1')

    const queryClient = createTestQueryClient()
    const { rerender } = renderAppElement(queryClient)

    expect(window.location.pathname).toBe('/ticket/LT-1')

    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    rerender(
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <App />
        </UIProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Ticket Dashboard')).toBeInTheDocument()
    })
    expect(window.location.pathname).toBe('/ticket/LT-1')
  })

  it('pushes the ticket route when a ticket is selected and clears it when it closes', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]

    renderAppWithProbe()
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    fireEvent.click(screen.getByRole('button', { name: 'Select LT-1' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    // Both are the user's own transitions, so both are undoable. Asserting only
    // the pathname would pass just as happily on a pair of replaces.
    expect(pushState.mock.calls.map(call => call[2])).toEqual(['/ticket/LT-1', '/'])
    expect(replaceState).not.toHaveBeenCalled()
  })

  /**
   * The first write the app makes is not automatically a reconciliation.
   *
   * The repair token used to start one ahead of the ref that consumes it, on
   * the reasoning that the entry URL is always something to correct. That made
   * *whatever wrote first* a replace — and with a modal open the route effect is
   * deliberately allowed to write before hydration, so the first user gesture on
   * a still-loading app destroyed the entry it should have been pushed onto.
   */
  it('pushes a modal opened before the ticket list settles, and still honours the deep link', async () => {
    persistTicketSelection('ticket-2', 'LT-2')
    mockState.tickets = [
      { id: 'ticket-1', externalId: 'LT-1' },
      { id: 'ticket-2', externalId: 'LT-2' },
    ]
    mockState.ticketsFetched = false
    mockState.ticketsLoading = true
    window.history.pushState(null, '', '/ticket/LT-1')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    const queryClient = createTestQueryClient()
    const { rerender } = renderAppElement(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Open Configuration' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/config')
    })
    expect(pushState).toHaveBeenCalledWith(null, '', '/config')
    expect(replaceState).not.toHaveBeenCalled()

    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    rerenderAppElement(rerender, queryClient)

    // Hydration reads the pathname the tab was opened with, not the live bar —
    // which by now says `/config`. Closing the modal returns to the deep link
    // rather than to the restored LT-2.
    fireEvent.click(screen.getByRole('button', { name: 'Close Configuration' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })
  })

  /**
   * Reopening the ticket the last session left selected is a transition, not a
   * correction: the board is behind it and Back should reach it. This was a
   * replace for the same start-one-ahead reason, so Back left the app.
   */
  it('pushes the restored ticket route so Back reaches the board', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })
    expect(pushState).toHaveBeenCalledWith(null, '', '/ticket/LT-1')
    expect(replaceState).not.toHaveBeenCalled()
  })

  /**
   * A ticket deleted here, or in another tab, while it is on screen. The board
   * is what gets shown and the address bar has to follow — as a correction. Back
   * onto the dead ticket route already replaced; this path pushed, so Back
   * handed the user the dead URL and then corrected it a second time.
   */
  it('replaces the ticket route when the selected ticket disappears from the list', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]

    const { rerenderApp } = renderAppWithProbe()
    fireEvent.click(screen.getByRole('button', { name: 'Select LT-1' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })

    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    mockState.tickets = []
    rerenderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * A typo, a stale bookmark, a path from a future version. The board is what
   * gets shown either way, so the bar must stop claiming otherwise — by
   * overwriting the entry, not stacking one on it.
   */
  it('replaces an entry URL the app has no route for', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/nowhere')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * The same path reached through history rather than typed. Nothing matched,
   * no route input moved, and the effect had no reason to run — so the bar sat
   * on `/nowhere` with the board behind it. Unresolvable *ticket* routes were
   * repaired here; anything else was not.
   */
  it('repairs the URL when Back lands on a path the app has no route for', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]

    renderApp()
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })

    window.history.pushState(null, '', '/nowhere')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * The logo is the way out of anywhere, including out of a deep link that has
   * not resolved yet. It did nothing at all during the load window: the route
   * effect still bailed out on the un-hydrated URL, so the bar kept the ticket
   * route, and hydration then selected the ticket the user had just left.
   */
  it('goes home when the logo is clicked before the ticket list settles', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    mockState.ticketsFetched = false
    mockState.ticketsLoading = true
    window.history.pushState(null, '', '/ticket/LT-1')

    const queryClient = createTestQueryClient()
    const { rerender } = renderAppElement(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Logo' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })

    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    rerenderAppElement(rerender, queryClient)

    await waitFor(() => {
      expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    })
    expect(window.location.pathname).toBe('/')
  })

  /**
   * Hydration spends itself once, so it waits for a *successful* list rather
   * than a settled one. A failed fetch resolves nothing: latching on it would
   * leave the deep link unreconciled for the rest of the session, and the retry
   * seconds later would find nothing left to do.
   */
  it('honours the deep link once the ticket list recovers from an error', async () => {
    persistTicketSelection('ticket-2', 'LT-2')
    mockState.tickets = [
      { id: 'ticket-1', externalId: 'LT-1' },
      { id: 'ticket-2', externalId: 'LT-2' },
    ]
    mockState.ticketsError = true
    window.history.pushState(null, '', '/ticket/LT-1')

    const queryClient = createTestQueryClient()
    const { rerender } = renderAppElement(queryClient)

    expect(window.location.pathname).toBe('/ticket/LT-1')

    mockState.ticketsError = false
    rerenderAppElement(rerender, queryClient)

    await waitFor(() => {
      expect(screen.getByText('Ticket Dashboard')).toBeInTheDocument()
    })
    expect(window.location.pathname).toBe('/ticket/LT-1')
  })

  /**
   * One mapping between a modal and its route, so back/forward and a fresh load
   * of the same URL agree. They did not: the handler tested `/ticket/` before
   * `/ticket/new`, so Forward to the New Ticket route closed every modal while
   * opening that URL directly showed the dialog.
   */
  it('opens the New Ticket dialog on a Forward to its route', async () => {
    renderApp()

    window.history.pushState(null, '', '/ticket/new')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(await screen.findByText('Ticket Form')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/ticket/new')
  })

  it('swaps Configuration for Prompts on a Back to the prompts route', async () => {
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()

    window.history.pushState(null, '', '/prompts')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => {
      expect(screen.queryByText('Profile Setup')).not.toBeInTheDocument()
    })
    expect(window.location.pathname).toBe('/prompts')
  })

  /**
   * Hydration settles on the ticket list settling, not on it being non-empty.
   * Keyed to the empty list because that is the case a `!tickets?.length` guard
   * never releases: the route effect would stay frozen for the whole session.
   */
  it('releases the route effect when the ticket list settles empty', async () => {
    mockState.tickets = []
    window.history.pushState(null, '', '/ticket/LT-9')

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
  })

  /**
   * A pathname naming a ticket the account does not have — deleted since the
   * link was shared, mistyped, copied from another machine — is reconciled, not
   * honoured. The reconciliation *replaces* that entry: the URL was never a
   * place the user chose to be, so Back has to reach whatever they were looking
   * at before, not hand them the dead link again.
   */
  it('replaces an unresolvable entry URL instead of stacking a history entry on it', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/ticket/LT-404')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    expect(replaceState).toHaveBeenCalled()
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * The same rule after the app is running. Back onto a ticket that has since
   * been deleted leaves the address bar pointing at a ticket the board is not
   * showing, and nothing about the board changed to prompt a correction — which
   * is why the repair is tracked explicitly rather than inferred from the route
   * inputs, none of which move in this case.
   */
  it('repairs the URL when Back lands on a ticket that no longer exists', async () => {
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })

    window.history.pushState(null, '', '/ticket/LT-404')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    // The pathname alone would read the same after a push, which would leave
    // the dead link one Back away and needing a second repair.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * Closing a modal overwrites the entry it opened. Pushing instead meant Back
   * from a closed modal re-opened it, so the gesture that dismissed the dialog
   * was also the gesture that brought it back.
   */
  it('replaces the modal entry when the modal closes', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()

    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    fireEvent.click(screen.getByRole('button', { name: 'Close Configuration' }))

    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/ticket/LT-1')
    expect(pushState).not.toHaveBeenCalled()
  })

  /**
   * The logo is the way out of anywhere. It used to write the URL itself, which
   * made the shell a second history owner racing the route effect; now it asks
   * `App` for the whole transition — modal closed, ticket deselected, one route
   * write for both.
   */
  it('closes the open modal and deselects the ticket when the logo is clicked', async () => {
    persistTicketSelection('ticket-1', 'LT-1')
    mockState.tickets = [{ id: 'ticket-1', externalId: 'LT-1' }]
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Logo' }))

    await waitFor(() => {
      expect(screen.queryByText('Profile Setup')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})

describe('App startup notices', () => {
  beforeEach(() => {
    mockState.tickets = []
    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    mockState.ticketsError = false
    mockState.dismissMutation.isPending = false
    mockState.dismissMutation.mutate.mockReset()
    useRecoveryAutoReloadMock.mockReset()
    localStorage.clear()
  })

  it('opens the About modal from Configuration', async () => {
    mockState.startupStatus = makeStartupStatus()
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open About' }))

    expect(await screen.findByText('About Dialog')).toBeInTheDocument()

    window.history.pushState(null, '', '/')
  })

  /**
   * About is a full-page overlay with no route of its own. Back reconciled every
   * routed overlay and left About floating over the board, on top of nothing.
   */
  it('closes the About overlay when the user navigates back', async () => {
    mockState.startupStatus = makeStartupStatus()
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open About' }))
    expect(await screen.findByText('About Dialog')).toBeInTheDocument()

    window.history.pushState(null, '', '/')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => {
      expect(screen.queryByText('About Dialog')).not.toBeInTheDocument()
    })
  })

  it('closes the About overlay with the Configuration modal it was opened from', async () => {
    mockState.startupStatus = makeStartupStatus()
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    window.history.pushState(null, '', '/config')

    renderApp()

    expect(await screen.findByText('Profile Setup')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open About' }))
    expect(await screen.findByText('About Dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close Configuration' }))

    await waitFor(() => {
      expect(screen.queryByText('About Dialog')).not.toBeInTheDocument()
    })

    window.history.pushState(null, '', '/')
  })

  it('does not show the restore popup for fresh startup state', () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    mockState.startupStatus = makeStartupStatus({
      kind: 'fresh',
      profileRestored: false,
      restoredProjectCount: 0,
      restoredProjects: [],
    })
    mockState.startupStatus.ui.restoreNotice.shouldShow = false

    renderApp()

    expect(screen.queryByText('Existing Local Data Found')).not.toBeInTheDocument()
  })

  it('does not show the restore popup for empty existing startup state', () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    mockState.startupStatus = makeStartupStatus({
      kind: 'empty_existing',
      profileRestored: false,
      restoredProjectCount: 0,
      restoredProjects: [],
    })
    mockState.startupStatus.ui.restoreNotice.shouldShow = false

    renderApp()

    expect(screen.queryByText('Existing Local Data Found')).not.toBeInTheDocument()
  })

  it('waits for the welcome disclaimer to be dismissed before showing the restore popup', async () => {
    mockState.startupStatus = makeStartupStatus()

    renderApp()

    expect(screen.getByText('Welcome to LoopTroop')).toBeInTheDocument()
    expect(screen.queryByText('Existing Local Data Found')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /got it, let's go!/i }))

    expect(await screen.findByText('Existing Local Data Found')).toBeInTheDocument()
  })

  it('shows the WSL app-path warning in the welcome disclaimer when applicable', () => {
    mockState.startupStatus = makeStartupStatus()
    mockState.startupStatus.runtime = {
      isWsl: true,
      osLabel: 'Linux',
      appRoot: '/mnt/d/LoopTroop',
      appPathWarning:
        'LoopTroop is running from /mnt/d/LoopTroop inside WSL. Keeping the app on a Windows-mounted drive can significantly degrade file watching, Git, and overall app performance. If you want to use WSL, move or install LoopTroop under /home or another Linux filesystem path.',
    }

    renderApp()

    expect(screen.getByText('WSL performance warning')).toBeInTheDocument()
    expect(screen.getByText(/running from \/mnt\/d\/LoopTroop inside WSL/i)).toBeInTheDocument()
  })

  it('adapts restore popup copy for profile-only, project-only, and combined restores', async () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')

    mockState.startupStatus = makeStartupStatus({
      profileRestored: true,
      restoredProjectCount: 2,
      restoredProjects: [
        {
          name: 'Alpha',
          shortname: 'ALP',
          folderPath: '/work/alpha',
        },
        {
          name: 'Beta',
          shortname: 'BET',
          folderPath: '/work/beta',
        },
      ],
    })
    const { rerender } = renderApp()
    expect(screen.getByText('Restored your saved LoopTroop profile and 2 projects.')).toBeInTheDocument()

    mockState.startupStatus = makeStartupStatus({
      profileRestored: true,
      restoredProjectCount: 0,
      restoredProjects: [],
    })
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <UIProvider>
          <App />
        </UIProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByText('Restored your saved LoopTroop profile.')).toBeInTheDocument()

    mockState.startupStatus = makeStartupStatus({
      profileRestored: false,
      restoredProjectCount: 3,
      restoredProjects: [
        {
          name: 'Alpha',
          shortname: 'ALP',
          folderPath: '/work/alpha',
        },
        {
          name: 'Beta',
          shortname: 'BET',
          folderPath: '/work/beta',
        },
        {
          name: 'Gamma',
          shortname: 'GAM',
          folderPath: '/work/gamma',
        },
      ],
    })
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <UIProvider>
          <App />
        </UIProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByText('Restored 3 projects from existing local LoopTroop data.')).toBeInTheDocument()
    expect(screen.getByText('/home/liviu/.config/looptroop/app.sqlite')).toBeInTheDocument()
    expect(screen.getByText(/Alpha/)).toBeInTheDocument()
    expect(screen.getByText(/Beta/)).toBeInTheDocument()
    expect(screen.getByText(/Gamma/)).toBeInTheDocument()
    expect(screen.getByText('/work/alpha')).toBeInTheDocument()
    expect(screen.getByText('/work/beta')).toBeInTheDocument()
    expect(screen.getByText('/work/gamma')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('This notice is stored with your local LoopTroop app data and will not appear again after dismissal.')).toBeInTheDocument()
    })
  })

  it('closes the restore popup after a successful dismissal', async () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    mockState.startupStatus = makeStartupStatus()
    mockState.dismissMutation.mutate.mockImplementation((_: undefined, options?: {
      onSuccess?: () => void
    }) => {
      options?.onSuccess?.()
    })

    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(screen.queryByText('Existing Local Data Found')).not.toBeInTheDocument()
    })
  })

  it('keeps the popup open and shows a toast when dismissal fails', async () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    mockState.startupStatus = makeStartupStatus()
    mockState.dismissMutation.mutate.mockImplementation((_: undefined, options?: {
      onError?: (error: Error) => void
    }) => {
      options?.onError?.(new Error('Failed to dismiss restore notice'))
    })

    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Existing Local Data Found')).toBeInTheDocument()
    expect(await screen.findByText('Failed to dismiss restore notice')).toBeInTheDocument()
  })

  it('closes a persisted ticket selection when that ticket no longer exists after refresh', async () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      selectedTicketId: 'missing-ticket',
      selectedTicketExternalId: MISSING_TICKET_EXTERNAL_ID,
      activeView: 'ticket',
      sidebarOpen: true,
      logPanelHeight: 300,
      filters: {
        projectId: null,
        status: null,
        search: '',
      },
      theme: 'system',
    }))
    mockState.startupStatus = makeStartupStatus({
      kind: 'fresh',
      profileRestored: false,
      restoredProjectCount: 0,
      restoredProjects: [],
    })
    mockState.startupStatus.ui.restoreNotice.shouldShow = false
    mockState.tickets = []

    renderApp()

    await waitFor(() => {
      expect(screen.getByText('Kanban Board')).toBeInTheDocument()
    })
    expect(screen.queryByText('Ticket Dashboard')).not.toBeInTheDocument()
  })

  it('arms ticket-list recovery reloads only after the initial ticket list has loaded once', async () => {
    localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    mockState.startupStatus = makeStartupStatus({
      kind: 'fresh',
      profileRestored: false,
      restoredProjectCount: 0,
      restoredProjects: [],
    })
    mockState.startupStatus.ui.restoreNotice.shouldShow = false
    mockState.ticketsFetched = false
    mockState.ticketsLoading = true
    const queryClient = createTestQueryClient()
    const { rerender } = renderAppElement(queryClient)

    expect(useRecoveryAutoReloadMock).toHaveBeenLastCalledWith('tickets-loading', false)

    mockState.ticketsFetched = true
    mockState.ticketsLoading = false
    rerender(
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <App />
        </UIProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(useRecoveryAutoReloadMock).toHaveBeenLastCalledWith('tickets-loading', false)
    })

    mockState.ticketsFetched = false
    mockState.ticketsLoading = true
    rerender(
      <QueryClientProvider client={queryClient}>
        <UIProvider>
          <App />
        </UIProvider>
      </QueryClientProvider>,
    )

    expect(useRecoveryAutoReloadMock).toHaveBeenLastCalledWith('tickets-loading', true)
  })
})
