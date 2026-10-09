import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCreateTicket, useTicketAction, useUpdateTicket, type Ticket } from '@/hooks/useTickets'
import { useProjects, type Project } from '@/hooks/useProjects'
import { useProfile } from '@/hooks/useProfile'
import { useUI } from '@/context/useUI'
import { useToast } from '@/components/shared/useToast'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import type { AiQuestionsOverride, AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import {
  TicketAdvancedFields,
  TicketDescriptionField,
  TicketFormActions,
  TicketPriorityField,
  TicketProjectField,
  TicketTitleField,
} from './TicketFormSections'

interface TicketFormProps {
  onClose: () => void
  onDirtyChange?: (isDirty: boolean) => void
  onEditingChange?: (isEditing: boolean) => void
}

const withoutTicketProject = (snapshot: string): string => {
  const parsed = JSON.parse(snapshot) as { projectId?: number | ''; [key: string]: unknown }
  const { projectId: _projectId, ...rest } = parsed
  return JSON.stringify(rest)
}

const canHydrateTicketBaseline = (baseline: string | null, snapshot: string) => baseline !== null && withoutTicketProject(baseline) === withoutTicketProject(snapshot)

const getSelectedTicketProject = (projects: Project[], projectId: number | '') => projects.find(project => project.id === projectId) ?? projects[0]

const isTicketWorkflowLocked = (ticket: Ticket | null, creatingAndStarting: boolean, startPending: boolean) => creatingAndStarting || startPending || (ticket !== null && ticket.status !== 'DRAFT')

const isTicketProjectDisabled = (editing: boolean, createPending: boolean, startPending: boolean) => editing || createPending || startPending

const isTicketQuestionsDisabled = (locked: boolean, profileLoading: boolean, projectsLoading: boolean) => locked || profileLoading || projectsLoading

const getTicketPendingState = (creatingAndStarting: boolean, createPending: boolean, startPending: boolean, updatePending: boolean) => ({
  starting: [creatingAndStarting, createPending, startPending].some(Boolean),
  saving: [creatingAndStarting, createPending, updatePending].some(Boolean),
  pending: [creatingAndStarting, createPending, startPending, updatePending].some(Boolean),
})

const canSubmitTicket = (pending: boolean, hasWaitError: boolean, projectId: number | '') => !pending && !hasWaitError && Boolean(projectId)

const getStartedTicketStatus = (result?: { status?: string; state?: string }) => result?.status ?? result?.state

const reportCreateAndStartFailure = (error: unknown, ticketWasCreated: boolean) => {
  const message = error instanceof Error ? error.message : 'Failed to start ticket'
  window.alert(ticketWasCreated
    ? `Ticket created, but it could not start: ${message}`
    : `Unable to create and start ticket: ${message}`)
}

export const TicketForm = ({ onClose, onDirtyChange, onEditingChange }: TicketFormProps) => {
  const { dispatch } = useUI()
  const { addToast } = useToast()
  const createTicket = useCreateTicket()
  const { mutate: updateTicket, isPending: isUpdatePending } = useUpdateTicket()
  const { mutateAsync: startTicket, isPending: isStartPending } = useTicketAction()
  const { data: projects = [], isLoading: projectsLoading } = useProjects()
  const { data: profile, isLoading: profileLoading } = useProfile()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState(3)
  const [projectId, setProjectId] = useState<number | ''>('')
  const [manualQaOverride, setManualQaOverride] = useState<ManualQaOverride>(null)
  const [aiQuestionsOverride, setAiQuestionsOverride] = useState<AiQuestionsOverride>(null)
  const [aiQuestionWindowOverride, setAiQuestionWindowOverride] = useState<AiQuestionWindowOverride>(null)
  const [hasAiQuestionWaitError, setHasAiQuestionWaitError] = useState(false)
  const [createdTicket, setCreatedTicket] = useState<Ticket | null>(null)
  const [isCreatingAndStarting, setIsCreatingAndStarting] = useState(false)
  const startedCreatedTicketRef = useRef(false)
  const ticketBaselineRef = useRef<string | null>(null)
  const ticketProjectsHydratedRef = useRef(projects.length > 0)
  const isEditing = createdTicket !== null
  const selectedProject = getSelectedTicketProject(projects, projectId)
  const effectiveProjectId = selectedProject?.id ?? ''
  const draftSnapshot = JSON.stringify({
    title,
    description,
    projectId: effectiveProjectId,
    priority,
    manualQaOverride,
    aiQuestionsOverride,
    aiQuestionWindowOverride,
  })
  if (ticketBaselineRef.current === null) ticketBaselineRef.current = draftSnapshot
  const draftSnapshotRef = useRef(draftSnapshot)
  draftSnapshotRef.current = draftSnapshot
  useEffect(() => {
    if (ticketProjectsHydratedRef.current || projects.length === 0) return
    ticketProjectsHydratedRef.current = true
    if (!canHydrateTicketBaseline(ticketBaselineRef.current, draftSnapshotRef.current)) return
    ticketBaselineRef.current = draftSnapshotRef.current
    onDirtyChange?.(false)
  }, [effectiveProjectId, onDirtyChange, projects.length])
  const isDirty = [hasAiQuestionWaitError, draftSnapshot !== ticketBaselineRef.current].some(Boolean)
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])
  useEffect(() => {
    onEditingChange?.(isEditing)
  }, [isEditing, onEditingChange])

  const pendingState = getTicketPendingState(isCreatingAndStarting, createTicket.isPending, isStartPending, isUpdatePending)
  const canCreate = canSubmitTicket(pendingState.pending, hasAiQuestionWaitError, effectiveProjectId)
  const workflowLocked = isTicketWorkflowLocked(createdTicket, isCreatingAndStarting, isStartPending)
  const projectDisabled = isTicketProjectDisabled(isEditing, createTicket.isPending, isStartPending)
  const questionsDisabled = isTicketQuestionsDisabled(workflowLocked, profileLoading, projectsLoading)
  const createInput = () => ({
    projectId: effectiveProjectId as number,
    title,
    description: description || undefined,
    priority,
    // Send the tri-state so future project/profile changes still reach inherited tickets.
    manualQaOverride,
    aiQuestionsOverride,
    aiQuestionWindowOverride,
  })

  const recordSubmittedSnapshot = (submittedSnapshot: string) => {
    ticketBaselineRef.current = submittedSnapshot
    const hasLaterEdits = draftSnapshotRef.current !== submittedSnapshot
    onDirtyChange?.(hasLaterEdits)
    return hasLaterEdits
  }

  const finishSubmission = (ticket: Ticket, submittedSnapshot: string, selectTicket: boolean) => {
    if (recordSubmittedSnapshot(submittedSnapshot)) return
    if (selectTicket) dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
    onClose()
  }

  const saveCreatedTicket = (ticket: Ticket) => {
    const submittedSnapshot = draftSnapshotRef.current
    const updateInput = {
      id: ticket.id,
      title,
      description,
      priority,
      ...(ticket.status === 'DRAFT' ? { manualQaOverride, aiQuestionsOverride, aiQuestionWindowOverride } : {}),
    }
    updateTicket(updateInput, {
      onSuccess: (updated: Ticket) => {
        setCreatedTicket(updated)
        finishSubmission(updated, submittedSnapshot, startedCreatedTicketRef.current)
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Failed to update ticket'
        addToast('error', `Unable to update ticket: ${message}`, 5000)
      },
    })
  }

  const createTicketDraft = () => {
    const submittedSnapshot = draftSnapshotRef.current
    createTicket.mutate(createInput(), {
      onSuccess: (created: Ticket) => {
        setCreatedTicket(created)
        finishSubmission(created, submittedSnapshot, false)
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Failed to create ticket'
        addToast('error', `Unable to create ticket: ${message}`, 5000)
      },
    })
  }

  const handleCreateAndStart = async () => {
    if (!canCreate) return
    const submittedSnapshot = draftSnapshotRef.current
    setIsCreatingAndStarting(true)
    let ticketWasCreated = false
    try {
      const created: Ticket = await createTicket.mutateAsync(createInput())
      ticketWasCreated = true
      setCreatedTicket(created)
      recordSubmittedSnapshot(submittedSnapshot)
      const started = await startTicket({ id: created.id, action: 'start' })
      startedCreatedTicketRef.current = true
      setCreatedTicket(current => current ? { ...current, status: getStartedTicketStatus(started) ?? current.status } : current)
      finishSubmission(created, submittedSnapshot, true)
    } catch (error) {
      reportCreateAndStartFailure(error, ticketWasCreated)
    } finally {
      setIsCreatingAndStarting(false)
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (hasAiQuestionWaitError) return
    if (!effectiveProjectId) {
      addToast('warning', 'Attach a project before creating a ticket.')
      return
    }
    if (!canCreate) return
    if (createdTicket) {
      saveCreatedTicket(createdTicket)
      return
    }
    createTicketDraft()
  }

  const handleClose = () => {
    if (isDirty && !window.confirm('Discard your unsaved ticket changes?')) return
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">Ticket Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <TicketProjectField projects={projects} project={selectedProject} disabled={projectDisabled} onSelect={setProjectId} />
          <TicketTitleField title={title} onChange={setTitle} />
          <TicketDescriptionField description={description} onChange={setDescription} />
          <TicketPriorityField priority={priority} onChange={setPriority} />
          <TicketAdvancedFields
            project={selectedProject}
            profile={profile}
            locked={workflowLocked}
            questionsDisabled={questionsDisabled}
            manualQaOverride={manualQaOverride}
            onManualQaChange={setManualQaOverride}
            aiQuestionsOverride={aiQuestionsOverride}
            onAiQuestionsChange={setAiQuestionsOverride}
            aiQuestionWindowOverride={aiQuestionWindowOverride}
            onAiQuestionWindowChange={setAiQuestionWindowOverride}
            hasWaitError={hasAiQuestionWaitError}
            onValidationChange={setHasAiQuestionWaitError}
          />
        </CardContent>
      </Card>
      <TicketFormActions editing={isEditing} canSubmit={canCreate} starting={pendingState.starting} saving={pendingState.saving} onClose={handleClose} onCreateAndStart={handleCreateAndStart} />
    </form>
  )
}
