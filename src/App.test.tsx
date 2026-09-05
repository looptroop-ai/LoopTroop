import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
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
    isSuccess: mockState.ticketsFetched && !mockState.ticketsLoading,
    isError: mockState.ticketsError,
  }),
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

function renderAppWithProbe() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <UIProvider>
        <App />
        <SelectionProbe />
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

    fireEvent.click(screen.getByRole('button', { name: 'Select LT-1' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/ticket/LT-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }))
    await waitFor(() => {
      expect(window.location.pathname).toBe('/')
    })
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
