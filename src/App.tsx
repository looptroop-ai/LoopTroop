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
   * in storage. Until this has run the route effect below must not write, or a
   * deep-linked ticket is overwritten before it can be resolved.
   *
   * It settles when the ticket list settles rather than when it is non-empty:
   * an account with no tickets never resolves a deep link, but the route effect
   * still has to be released.
   */
  useEffect(() => {
    if (hasHydratedUrl) return
    if (!ticketsQuery.isSuccess && !ticketsQuery.isError) return
    const externalId = ticketExternalIdForPathname(window.location.pathname)
    const ticket = externalId ? tickets?.find(t => t.externalId === externalId) : undefined
    if (ticket) dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
    setHasHydratedUrl(true)
  }, [dispatch, hasHydratedUrl, tickets, ticketsQuery.isError, ticketsQuery.isSuccess])

  /**
   * The URL, owned here and derived in one place. `UIContext` used to push a
   * pathname of its own, which meant two writers: refreshing `/config` with a
   * ticket selected reopened Configuration and then had the context rewrite the
   * pathname to `/ticket/…` underneath it.
   *
   * A modal route covers the ticket route while it is open, and closing one
   * therefore returns to the ticket the user was on — the behaviour a remembered
   * previous pathname used to produce, without the remembering.
   */
  const baseRoute = state.activeView === 'ticket' && state.selectedTicketId
    ? `${TICKET_ROUTE_PREFIX}${state.selectedTicketExternalId ?? state.selectedTicketId}`
    : ROUTE_ROOT
  useEffect(() => {
    // With no modal and no resolved deep link, the pathname is still the user's
    // request rather than anything derived from state. Leave it alone.
    if (!activeModal && !hasHydratedUrl) return
    const target = activeModal ? MODAL_ROUTES[activeModal] : baseRoute
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target)
    }
  }, [activeModal, baseRoute, hasHydratedUrl])

  // Handle back/forward navigation
  useEffect(() => {
    const handlePop = () => {
      const pathname = window.location.pathname
      // About has no route of its own and sits above everything else, so a Back that
      // reconciles the routed overlays would otherwise close Configuration underneath
      // it and leave About floating over the board with nothing behind it.
      setIsAboutOpen(false)
      setActiveModal(modalForPathname(pathname))

      const externalId = ticketExternalIdForPathname(pathname)
      if (externalId) {
        const ticket = ticketsRef.current?.find(t => t.externalId === externalId)
        if (ticket) dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
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
