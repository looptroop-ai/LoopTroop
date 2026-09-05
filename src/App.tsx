import { Suspense, useCallback, useState, useEffect, useRef } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { TicketDashboard } from '@/components/ticket/TicketDashboard'
import { CenteredModal } from '@/components/shared/CenteredModal'
import { lazyWithChunkReload } from '@/lib/lazyWithChunkReload'

const ProfileSetup = lazyWithChunkReload('ProfileSetup', () => import('@/components/config/ProfileSetup').then(m => ({ default: m.ProfileSetup })))
const ProjectsPanel = lazyWithChunkReload('ProjectsPanel', () => import('@/components/project/ProjectsPanel').then(m => ({ default: m.ProjectsPanel })))
const TicketForm = lazyWithChunkReload('TicketForm', () => import('@/components/ticket/TicketForm').then(m => ({ default: m.TicketForm })))
const PromptsDialog = lazyWithChunkReload('PromptsDialog', () => import('@/components/prompts/PromptsDialog').then(m => ({ default: m.PromptsDialog })))
import { KeyboardShortcuts } from '@/components/shared/KeyboardShortcuts'
import { StartupRestorePopup } from '@/components/shared/StartupRestorePopup'
import { AboutDialog } from '@/components/config/AboutDialog'
import { ToastProvider } from '@/components/shared/Toast'
import { AIQuestionProvider } from '@/context/AIQuestionContext'
import {
  WelcomeDisclaimer,
  WELCOME_DISCLAIMER_STORAGE_KEY,
} from '@/components/shared/WelcomeDisclaimer'
import { useUI } from '@/context/useUI'
import { useTickets } from '@/hooks/useTickets'
import { useProfile } from '@/hooks/useProfile'
import { useStartupStatus } from '@/hooks/useStartupStatus'
import { useQueryClient } from '@tanstack/react-query'
import { clearOpenCodeModelsQuery } from '@/hooks/useOpenCodeModels'
import { useRecoveryAutoReload } from '@/hooks/useRecoveryAutoReload'
import { useWorkflowMeta } from '@/hooks/useWorkflowMeta'
import { preloadWorkspaceForView } from '@/components/ticket/workspacePreload'

const ROUTE_ROOT = '/'
const TICKET_ROUTE_PREFIX = '/ticket/'

/**
 * The one mapping between a modal and its route.
 *
 * Adding a modal used to mean editing four places that each encoded this
 * separately — the entry-URL reader, the back/forward handler, and an open and
 * a close helper per modal — and they had already drifted: back/forward to
 * `/ticket/new` matched the ticket-route branch first and closed every modal,
 * so the New Ticket dialog opened on a fresh load of that URL but not on a
 * Forward to it.
 */
const MODAL_ROUTES = {
  profile: '/config',
  prompts: '/prompts',
  project: '/project/new',
  ticket: '/ticket/new',
} as const

type ModalRoute = keyof typeof MODAL_ROUTES

const MODAL_ROUTE_ENTRIES = Object.entries(MODAL_ROUTES) as [ModalRoute, string][]

function modalForPathname(pathname: string): ModalRoute | null {
  return MODAL_ROUTE_ENTRIES.find(([, route]) => route === pathname)?.[0] ?? null
}

/**
 * A pathname this app has no route for: not the board, not a modal route, and
 * not shaped like a ticket route.
 *
 * These have to be corrected in place rather than pushed past. The board is
 * what gets shown either way, so a history entry for the unowned path is one
 * Back would return to only for the app to correct it a second time.
 */
function isUnownedPathname(pathname: string): boolean {
  return pathname !== ROUTE_ROOT
    && pathname !== ''
    && modalForPathname(pathname) === null
    && !pathname.startsWith(TICKET_ROUTE_PREFIX)
}

/** The external id a ticket route names, or null for `/ticket/new` and anything else. */
function ticketExternalIdForPathname(pathname: string): string | null {
  if (!pathname.startsWith(TICKET_ROUTE_PREFIX)) return null
  const externalId = pathname.slice(TICKET_ROUTE_PREFIX.length).split('/')[0] ?? ''
  return externalId && externalId !== 'new' ? externalId : null
}

type TicketRouteMatch =
  | { kind: 'none' }
  | { kind: 'ticket'; ticketId: string; externalId: string }
  | { kind: 'unresolved' }

/**
 * Reads a pathname against the ticket list, for both the entry URL and Back.
 *
 * `unresolved` is the case worth naming: the pathname asks for a ticket this
 * account does not have — deleted since the link was made, mistyped, or copied
 * from another machine. Treating that as `none` is what let the previous
 * session's restored selection quietly take the address bar and answer a
 * question the user did not ask.
 */
function matchTicketRoute(
  pathname: string,
  tickets: { id: string; externalId: string }[] | undefined,
): TicketRouteMatch {
  const externalId = ticketExternalIdForPathname(pathname)
  if (!externalId) return { kind: 'none' }
  const ticket = tickets?.find(t => t.externalId === externalId)
  return ticket ? { kind: 'ticket', ticketId: ticket.id, externalId: ticket.externalId } : { kind: 'unresolved' }
}

const MODAL_SUSPENSE_FALLBACK = <div className="p-4 text-center text-muted-foreground">Loading…</div>

function App() {
  useProfile() // Preload profile for faster Configuration open
  const { data: startupStatus } = useStartupStatus()
  const { state, dispatch } = useUI()
  const queryClient = useQueryClient()
  const ticketsQuery = useTickets()
  const tickets = ticketsQuery.data
  const { phaseMap } = useWorkflowMeta()
  const ticketsRef = useRef(tickets)
  useEffect(() => { ticketsRef.current = tickets }, [tickets])
  const hasCompletedInitialTicketListLoadRef = useRef(false)
  const isRecoverableTicketListLoading = ticketsQuery.isLoading === true
    && hasCompletedInitialTicketListLoadRef.current
  useRecoveryAutoReload('tickets-loading', isRecoverableTicketListLoading)
  const [hasHydratedUrl, setHasHydratedUrl] = useState(false)
  /**
   * A one-time snapshot of the pathname the tab was opened with.
   *
   * Hydration used to read the live address bar, which is only the entry URL
   * for as long as nothing has written to it — and the route effect is allowed
   * to write before hydration whenever a modal is open. Opening Configuration
   * while the ticket list was still in flight therefore replaced the deep link
   * with `/config`, and hydration then resolved `/config`: the ticket the link
   * named was never selected and was no longer anywhere to be found.
   */
  const entryPathnameRef = useRef(window.location.pathname)
  /**
   * Bumped whenever the app learns the pathname now in the bar is not one it
   * can honour, so the route effect overwrites that entry instead of pushing
   * past it.
   *
   * It starts level with `repairedRouteTokenRef`, so the *first* write is a
   * push unless something has asked for a repair. It used to start one ahead,
   * on the reasoning that the entry URL is always something to reconcile — but
   * that is a claim about hydration, not about the first write, and the first
   * write is often the user's: opening a modal before the list settles, or
   * reopening the restored ticket from `/`. Both were replacing the entry the
   * user would expect Back to return to. The genuine entry-URL repairs — a
   * ticket that no longer exists, a path this app has no route for — bump the
   * token from hydration instead, which is where they are actually detected.
   */
  const [routeRepairToken, setRouteRepairToken] = useState(0)
  const repairedRouteTokenRef = useRef(0)
  const previousModalRef = useRef<ModalRoute | null>(null)
  const [activeModal, setActiveModal] = useState<ModalRoute | null>(
    () => modalForPathname(window.location.pathname),
  )
  const [isAboutOpen, setIsAboutOpen] = useState(false)
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_DISCLAIMER_STORAGE_KEY)
    } catch {
      return true
    }
  })
  /** A one-time snapshot of the entry URL, not live state. */
  const openedWithModalRef = useRef(activeModal)
  const isRestorePopupOpen = !isWelcomeOpen
    && startupStatus?.storage.kind === 'restored'
    && startupStatus.ui.restoreNotice.shouldShow === true
  const isModalOpen = activeModal !== null || isAboutOpen || isWelcomeOpen || isRestorePopupOpen

  useEffect(() => {
    if (openedWithModalRef.current === 'profile') {
      clearOpenCodeModelsQuery(queryClient)
    }
  }, [queryClient])

  useEffect(() => {
    if (ticketsQuery.isFetched || ticketsQuery.isSuccess) {
      hasCompletedInitialTicketListLoadRef.current = true
    }
  }, [ticketsQuery.isFetched, ticketsQuery.isSuccess])

  /**
   * The selected ticket disappeared from the live list — deleted here, or in
   * another tab. The board is what gets shown, and the ticket route in the bar
   * has to be corrected rather than pushed past: a history entry naming a
   * ticket that no longer exists is one Back returns to only for the app to
   * correct it a second time. Back onto a deleted ticket already bumped the
   * token; this path is the same repair and was pushing.
   */
  useEffect(() => {
    if (!state.selectedTicketId || !ticketsQuery.isSuccess || !Array.isArray(tickets)) return
    if (tickets.some(ticket => ticket.id === state.selectedTicketId)) return
    dispatch({ type: 'CLOSE_TICKET' })
    setRouteRepairToken(token => token + 1)
  }, [dispatch, state.selectedTicketId, tickets, ticketsQuery.isSuccess])

  useEffect(() => {
    if (!state.selectedTicketId || !ticketsQuery.isSuccess || !tickets) return
    const selectedTicket = tickets.find((ticket) => ticket.id === state.selectedTicketId)
    if (!selectedTicket) return
    void preloadWorkspaceForView(phaseMap[selectedTicket.status]?.uiView)
  }, [phaseMap, state.selectedTicketId, tickets, ticketsQuery.isSuccess])

  const dismissWelcome = () => {
    try {
      localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
    } catch {
      // ignore storage errors
    }
    setIsWelcomeOpen(false)
  }

  /**
   * Reconcile the pathname the app was opened with, exactly once.
   *
   * The pathname wins over the restored selection: a deep link is what the user
   * asked for, while `selectedTicketId` is only what the previous session left
   * in storage. Until this has run the route effect below must not write a
   * derived pathname, or the deep link is overwritten before it can be resolved.
   *
   * It waits for a *successful* list, not merely a settled one. A failed fetch
   * resolves nothing, and latching on it would spend the single hydration pass
   * the deep link gets: the restored selection would take the address bar and
   * the retry seconds later would find nothing left to reconcile. An empty list
   * is a different thing — it is an answer, so it settles.
   */
  useEffect(() => {
    if (hasHydratedUrl || !ticketsQuery.isSuccess) return
    const entryPathname = entryPathnameRef.current
    const match = matchTicketRoute(entryPathname, tickets)
    if (match.kind === 'ticket') {
      dispatch({ type: 'SELECT_TICKET', ticketId: match.ticketId, externalId: match.externalId })
    } else if (match.kind === 'unresolved') {
      // Keeping the restored selection here would rewrite the address bar to a
      // different ticket than the one the link named, which reads as if the app
      // had honoured the link. The board is the honest answer.
      dispatch({ type: 'CLOSE_TICKET' })
      setRouteRepairToken(token => token + 1)
    } else if (isUnownedPathname(entryPathname)) {
      // A typo, a stale bookmark, a path from a future version. The board is
      // what gets shown, and the address bar has to stop claiming otherwise.
      setRouteRepairToken(token => token + 1)
    }
    setHasHydratedUrl(true)
  }, [dispatch, hasHydratedUrl, tickets, ticketsQuery.isSuccess])

  /**
   * The URL, owned here and derived in one place. `UIContext` used to push a
   * pathname of its own, which meant two writers: refreshing `/config` with a
   * ticket selected reopened Configuration and then had the context rewrite the
   * pathname to `/ticket/…` underneath it.
   *
   * A modal route covers the ticket route while it is open, and closing one
   * therefore returns to the ticket the user was on — the behaviour a remembered
   * previous pathname used to produce, without the remembering.
   *
   * `pushState` is for a transition the user made and may want to undo: opening
   * a modal, selecting a ticket, returning to the board. `replaceState` is for
   * the writes that only ever correct the address bar, because a history entry
   * there is one the app would immediately leave again:
   *
   *   - repairing a pathname naming a ticket this account does not have, or one
   *     this app has no route for at all, which Back would return to only to be
   *     corrected a second time;
   *   - closing a routed modal, which restores the route the modal opened over.
   *     Pushing duplicates that entry, so Back lands back on the modal route and
   *     reopens the dialog the user just dismissed.
   *
   * Everything else pushes, including the first write. A modal opened while the
   * ticket list is still in flight is a user transition like any other, and
   * reopening the restored ticket from `/` is one Back should undo onto the
   * board.
   */
  const baseRoute = state.activeView === 'ticket' && state.selectedTicketId
    ? `${TICKET_ROUTE_PREFIX}${state.selectedTicketExternalId ?? state.selectedTicketId}`
    : ROUTE_ROOT
  useEffect(() => {
    const closedModal = previousModalRef.current !== null && activeModal === null
    previousModalRef.current = activeModal
    // With no modal and no settled ticket list the pathname is still the user's
    // request rather than anything derived from state, so there is nothing yet
    // to reconcile it against. A modal that just closed is the exception: its
    // route is this effect's own doing and has to come back off either way, or
    // dismissing Configuration while the list is still loading leaves `/config`
    // in the address bar and a refresh reopens the dialog.
    if (!activeModal && !closedModal && !hasHydratedUrl) return
    const repairs = closedModal || routeRepairToken !== repairedRouteTokenRef.current
    repairedRouteTokenRef.current = routeRepairToken
    const target = activeModal ? MODAL_ROUTES[activeModal] : baseRoute
    if (window.location.pathname === target) return
    window.history[repairs ? 'replaceState' : 'pushState'](null, '', target)
  }, [activeModal, baseRoute, hasHydratedUrl, routeRepairToken])

  // Handle back/forward navigation
  useEffect(() => {
    const handlePop = () => {
      const pathname = window.location.pathname
      // About has no route of its own and sits above everything else, so a Back that
      // reconciles the routed overlays would otherwise close Configuration underneath
      // it and leave About floating over the board with nothing behind it.
      setIsAboutOpen(false)
      setActiveModal(modalForPathname(pathname))

      const match = matchTicketRoute(pathname, ticketsRef.current)
      if (match.kind === 'ticket') {
        dispatch({ type: 'SELECT_TICKET', ticketId: match.ticketId, externalId: match.externalId })
      } else if (match.kind === 'unresolved') {
        // Back onto a ticket deleted since it was last on screen. The repair is
        // the same as on entry, and the token is what makes the route effect run
        // at all: closing an already-closed ticket changes none of its inputs.
        dispatch({ type: 'CLOSE_TICKET' })
        setRouteRepairToken(token => token + 1)
      } else if (pathname === ROUTE_ROOT || pathname === '') {
        dispatch({ type: 'CLOSE_TICKET' })
      } else if (isUnownedPathname(pathname)) {
        // Back onto a path this app has no route for. A direct load of one is
        // repaired at hydration; arriving at the same path through history was
        // the hole — nothing matched, no input changed, and the bar sat on it
        // with the board on screen.
        dispatch({ type: 'CLOSE_TICKET' })
        setRouteRepairToken(token => token + 1)
      }
    }
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [dispatch])

  // One open and one close transition, shared by every routed modal. The URL
  // follows from the state through the route effect above.
  const openModal = useCallback((modal: ModalRoute) => {
    if (modal === 'profile') clearOpenCodeModelsQuery(queryClient)
    setActiveModal(modal)
  }, [queryClient])
  const closeModal = useCallback(() => {
    setActiveModal(null)
    // About is opened from inside Configuration; it has nowhere to belong once
    // Configuration is gone.
    setIsAboutOpen(false)
  }, [])
  /**
   * The logo means home, so it closes whatever is open on the way there.
   *
   * It used to write `/` itself, which made it the second writer of
   * `window.history` and put it in a fight with the route effect: with a modal
   * open the effect wrote the modal route straight back, and dismissing the
   * dialog then landed on the board rather than the ticket underneath it.
   *
   * It also settles hydration, because an explicit "take me home" *is* the
   * answer to the entry URL. Without that the logo did nothing at all while the
   * ticket list was loading: the route effect still bailed out on
   * `!hasHydratedUrl`, so the deep link stayed in the bar, and hydration then
   * selected the ticket the user had just asked to leave.
   */
  const navigateHome = useCallback(() => {
    setActiveModal(null)
    setIsAboutOpen(false)
    dispatch({ type: 'CLOSE_TICKET' })
    setHasHydratedUrl(true)
  }, [dispatch])
  const openAbout = useCallback(() => setIsAboutOpen(true), [])
  const closeAbout = useCallback(() => setIsAboutOpen(false), [])

  return (
    <ToastProvider>
      <AIQuestionProvider tickets={tickets ?? []}>
        <WelcomeDisclaimer
          open={isWelcomeOpen}
          onDismiss={dismissWelcome}
          appPathWarning={startupStatus?.runtime.appPathWarning ?? null}
        />
        {startupStatus && (
          <StartupRestorePopup
            open={isRestorePopupOpen}
            startupStatus={startupStatus}
          />
        )}
        <AppShell
          onOpenProfile={() => openModal('profile')}
          onOpenPrompts={() => openModal('prompts')}
          onOpenProject={() => openModal('project')}
          onOpenTicket={() => openModal('ticket')}
          onOpenAbout={openAbout}
          onNavigateHome={navigateHome}
          isModalOpen={isModalOpen}
        >
          {/*
            Keyed by ticket id on purpose: switching tickets unmounts the previous ticket's
            dashboard so every useState, useRef, timer and draft buffer below it is rebuilt from
            scratch. Without the key the subtree stays mounted and each surface keeps the previous
            ticket's state, which is how an answer typed for one ticket could be saved to another.
          */}
          {state.activeView === 'ticket' && state.selectedTicketId
            ? <TicketDashboard key={state.selectedTicketId} />
            : <KanbanBoard />}
        </AppShell>

        <CenteredModal open={activeModal === 'profile'} onClose={closeModal} title="Configuration" maxWidth="max-w-2xl" closeDisabled={isAboutOpen}>
          <Suspense fallback={MODAL_SUSPENSE_FALLBACK}>
            <ProfileSetup onClose={closeModal} onOpenAbout={openAbout} />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={activeModal === 'prompts'} onClose={closeModal} title="Prompts editor" maxWidth="max-w-[80vw]">
          <Suspense fallback={MODAL_SUSPENSE_FALLBACK}>
            <PromptsDialog />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={isAboutOpen} onClose={closeAbout} title="About" maxWidth="max-w-2xl" zIndexClass="z-[60]">
          <AboutDialog />
        </CenteredModal>

        <CenteredModal open={activeModal === 'project'} onClose={closeModal} title="Projects" maxWidth="max-w-2xl">
          <Suspense fallback={MODAL_SUSPENSE_FALLBACK}>
            <ProjectsPanel onClose={closeModal} />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={activeModal === 'ticket'} onClose={closeModal} title="New Ticket" maxWidth="max-w-xl">
          <Suspense fallback={MODAL_SUSPENSE_FALLBACK}>
            <TicketForm onClose={closeModal} />
          </Suspense>
        </CenteredModal>

        <KeyboardShortcuts />
      </AIQuestionProvider>
    </ToastProvider>
  )
}

export default App
