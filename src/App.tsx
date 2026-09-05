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
   * Bumped whenever the app learns the current pathname is not one it can
   * honour, so the route effect overwrites that entry instead of pushing past
   * it. Starts at 1 because the entry URL is itself something to reconcile
   * rather than a place Back should return to.
   */
  const [routeRepairToken, setRouteRepairToken] = useState(1)
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

  useEffect(() => {
    if (!state.selectedTicketId || !ticketsQuery.isSuccess || !Array.isArray(tickets)) return
    if (tickets.some(ticket => ticket.id === state.selectedTicketId)) return
    dispatch({ type: 'CLOSE_TICKET' })
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
    const match = matchTicketRoute(window.location.pathname, tickets)
    if (match.kind === 'ticket') {
      dispatch({ type: 'SELECT_TICKET', ticketId: match.ticketId, externalId: match.externalId })
    } else if (match.kind === 'unresolved') {
      // Keeping the restored selection here would rewrite the address bar to a
      // different ticket than the one the link named, which reads as if the app
      // had honoured the link. The board is the honest answer.
      dispatch({ type: 'CLOSE_TICKET' })
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
   *   - reconciling the entry URL, where the entry a push would add is the one
   *     the browser is already sitting on;
   *   - repairing a pathname naming a ticket this account does not have, which
   *     Back would return to only to be corrected a second time;
   *   - closing a routed modal, which restores the route the modal opened over.
   *     Pushing duplicates that entry, so Back lands back on the modal route and
   *     reopens the dialog the user just dismissed.
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
   */
  const navigateHome = useCallback(() => {
    setActiveModal(null)
    setIsAboutOpen(false)
    dispatch({ type: 'CLOSE_TICKET' })
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
