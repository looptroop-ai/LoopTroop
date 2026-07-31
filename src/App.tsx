import { Suspense, useState, useEffect, useRef } from 'react'
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
const ROUTE_CONFIG = '/config'
const ROUTE_PROJECT_NEW = '/project/new'
const ROUTE_TICKET_NEW = '/ticket/new'
const ROUTE_PROMPTS = '/prompts'

function getInitialModal(pathname: string): 'profile' | 'project' | 'ticket' | 'prompts' | null {
  if (pathname === ROUTE_CONFIG) return 'profile'
  if (pathname === ROUTE_PROJECT_NEW) return 'project'
  if (pathname === ROUTE_TICKET_NEW) return 'ticket'
  if (pathname === ROUTE_PROMPTS) return 'prompts'
  return null
}

function App() {
  const initialModal = getInitialModal(window.location.pathname)
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
  const initialUrlProcessed = useRef(false)
  const [isProfileOpen, setIsProfileOpen] = useState(() => initialModal === 'profile')
  const [isAboutOpen, setIsAboutOpen] = useState(false)
  const [isProjectOpen, setIsProjectOpen] = useState(() => initialModal === 'project')
  const [isTicketOpen, setIsTicketOpen] = useState(() => initialModal === 'ticket')
  const [isPromptsOpen, setIsPromptsOpen] = useState(() => initialModal === 'prompts')
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_DISCLAIMER_STORAGE_KEY)
    } catch {
      return true
    }
  })
  const prevPathRef = useRef(ROUTE_ROOT)
  const isRestorePopupOpen = !isWelcomeOpen
    && startupStatus?.storage.kind === 'restored'
    && startupStatus.ui.restoreNotice.shouldShow === true
  const isModalOpen = isProfileOpen || isAboutOpen || isProjectOpen || isTicketOpen || isPromptsOpen || isWelcomeOpen || isRestorePopupOpen

  useEffect(() => {
    if (initialModal === 'profile') {
      clearOpenCodeModelsQuery(queryClient)
    }
  }, [initialModal, queryClient])

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

  // Resolve ticket from URL externalId when tickets load
  useEffect(() => {
    if (!tickets?.length || initialUrlProcessed.current) return
    const path = window.location.pathname
    if (path.startsWith('/ticket/')) {
      const externalId = path.split('/')[2]
      if (externalId && externalId !== 'new') {
        const ticket = tickets.find(t => t.externalId === externalId)
        if (ticket) dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
      }
    }
    initialUrlProcessed.current = true
  }, [tickets, dispatch])

  // Handle back/forward navigation
  useEffect(() => {
    const handlePop = () => {
      const p = window.location.pathname
      prevPathRef.current = p
      setIsPromptsOpen(p === ROUTE_PROMPTS)
      if (p === ROUTE_ROOT || p === '') {
        dispatch({ type: 'CLOSE_TICKET' })
        setIsProfileOpen(false)
        setIsProjectOpen(false)
        setIsTicketOpen(false)
      } else if (p === ROUTE_PROMPTS) {
        setIsProfileOpen(false)
        setIsProjectOpen(false)
        setIsTicketOpen(false)
      } else if (p.startsWith('/ticket/')) {
        const externalId = p.split('/')[2] ?? ''
        if (externalId && externalId !== 'new') {
          const ticket = ticketsRef.current?.find(t => t.externalId === externalId)
          if (ticket) dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
        }
        setIsProfileOpen(false)
        setIsProjectOpen(false)
        setIsTicketOpen(false)
      } else if (p === ROUTE_CONFIG) {
        setIsProfileOpen(true)
        setIsProjectOpen(false)
        setIsTicketOpen(false)
      } else if (p === ROUTE_PROJECT_NEW) {
        setIsProfileOpen(false)
        setIsProjectOpen(true)
        setIsTicketOpen(false)
      } else if (p === ROUTE_TICKET_NEW) {
        setIsProfileOpen(false)
        setIsProjectOpen(false)
        setIsTicketOpen(true)
      }
    }
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [dispatch])

  // Modal open/close helpers that sync URL
  const openProfile = () => {
    clearOpenCodeModelsQuery(queryClient)
    prevPathRef.current = window.location.pathname
    window.history.pushState(null, '', ROUTE_CONFIG)
    setIsProfileOpen(true)
  }
  const closeProfile = () => {
    window.history.pushState(null, '', prevPathRef.current)
    setIsProfileOpen(false)
  }
  const openPrompts = () => {
    prevPathRef.current = window.location.pathname
    window.history.pushState(null, '', ROUTE_PROMPTS)
    setIsPromptsOpen(true)
  }
  const closePrompts = () => {
    window.history.pushState(null, '', prevPathRef.current)
    setIsPromptsOpen(false)
  }
  const openAbout = () => {
    setIsAboutOpen(true)
  }
  const closeAbout = () => {
    setIsAboutOpen(false)
  }
  const openProject = () => {
    prevPathRef.current = window.location.pathname
    window.history.pushState(null, '', ROUTE_PROJECT_NEW)
    setIsProjectOpen(true)
  }
  const closeProject = () => {
    window.history.pushState(null, '', prevPathRef.current)
    setIsProjectOpen(false)
  }
  const openTicket = () => {
    prevPathRef.current = window.location.pathname
    window.history.pushState(null, '', ROUTE_TICKET_NEW)
    setIsTicketOpen(true)
  }
  const closeTicket = () => {
    window.history.pushState(null, '', prevPathRef.current)
    setIsTicketOpen(false)
  }

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
          onOpenProfile={openProfile}
          onOpenPrompts={openPrompts}
          onOpenProject={openProject}
          onOpenTicket={openTicket}
          isModalOpen={isModalOpen}
        >
          {state.activeView === 'ticket' && state.selectedTicketId ? <TicketDashboard /> : <KanbanBoard />}
        </AppShell>

        <CenteredModal open={isProfileOpen} onClose={closeProfile} title="Configuration" maxWidth="max-w-2xl" closeDisabled={isAboutOpen}>
          <Suspense fallback={<div className="p-4 text-center text-muted-foreground">Loading…</div>}>
            <ProfileSetup onClose={closeProfile} onOpenAbout={openAbout} />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={isPromptsOpen} onClose={closePrompts} title="Prompts" maxWidth="max-w-[80vw]">
          <Suspense fallback={<div className="p-4 text-center text-muted-foreground">Loading…</div>}>
            <PromptsDialog />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={isAboutOpen} onClose={closeAbout} title="About" maxWidth="max-w-2xl" zIndexClass="z-[60]">
          <AboutDialog />
        </CenteredModal>

        <CenteredModal open={isProjectOpen} onClose={closeProject} title="Projects" maxWidth="max-w-2xl">
          <Suspense fallback={<div className="p-4 text-center text-muted-foreground">Loading…</div>}>
            <ProjectsPanel onClose={closeProject} />
          </Suspense>
        </CenteredModal>

        <CenteredModal open={isTicketOpen} onClose={closeTicket} title="New Ticket" maxWidth="max-w-xl">
          <Suspense fallback={<div className="p-4 text-center text-muted-foreground">Loading…</div>}>
            <TicketForm onClose={closeTicket} />
          </Suspense>
        </CenteredModal>

        <KeyboardShortcuts />
      </AIQuestionProvider>
    </ToastProvider>
  )
}

export default App
