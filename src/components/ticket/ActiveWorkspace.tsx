import { Suspense, useEffect, useMemo } from 'react'
import type { Ticket } from '@/hooks/useTickets'
import { useWorkflowMeta } from '@/hooks/useWorkflowMeta'
import { getActiveErrorOccurrence, getTicketErrorOccurrences } from '@/lib/errorOccurrences'
import { isBeforeExecution } from '@shared/workflowMeta'
import { lazyWithChunkReload } from '@/lib/lazyWithChunkReload'
import {
  importApprovalView,
  importCanceledView,
  importCodingView,
  importCouncilView,
  importDraftView,
  importErrorView,
  importInterviewQAView,
  importPhaseReviewView,
} from './workspacePreload'

const DraftView = lazyWithChunkReload('DraftView', importDraftView)
const CouncilView = lazyWithChunkReload('CouncilView', importCouncilView)
const InterviewQAView = lazyWithChunkReload('InterviewQAView', importInterviewQAView)
const ApprovalView = lazyWithChunkReload('ApprovalView', importApprovalView)
const CodingView = lazyWithChunkReload('CodingView', importCodingView)
const ErrorView = lazyWithChunkReload('ErrorView', importErrorView)
const CanceledView = lazyWithChunkReload('CanceledView', importCanceledView)
const PhaseReviewView = lazyWithChunkReload('PhaseReviewView', importPhaseReviewView)
const FullLogView = lazyWithChunkReload('FullLogView', () => import('@/components/workspace/FullLogView').then(m => ({ default: m.FullLogView })))
const ManualQAView = lazyWithChunkReload('ManualQAView', () => import('@/components/workspace/ManualQAView').then(m => ({ default: m.ManualQAView })))

interface ActiveWorkspaceProps {
  ticket: Ticket
  selectedPhase: string
  selectedErrorOccurrenceId?: string | null
  previousStatus?: string
  reviewCutoffStatus?: string
  fullLogOpen?: boolean
}

function isReviewablePhase(
  phase: string,
  currentStatus: string,
  phaseOrder: string[],
  reviewCutoffStatus?: string,
  visitedStatuses: string[] = [],
): boolean {
  const phaseIndex = phaseOrder.indexOf(phase)
  if (currentStatus === 'CANCELED') {
    if (visitedStatuses.includes(phase)) return true
    if (!reviewCutoffStatus) return false
    const cutoffIndex = phaseOrder.indexOf(reviewCutoffStatus)
    return phaseIndex >= 0 && cutoffIndex >= 0 && phaseIndex <= cutoffIndex
  }
  const currentIndex = phaseOrder.indexOf(currentStatus)
  return phaseIndex >= 0 && currentIndex >= 0 && (phaseIndex < currentIndex || (phase !== currentStatus && visitedStatuses.includes(phase)))
}

export function ActiveWorkspace({ ticket, selectedPhase, selectedErrorOccurrenceId, previousStatus, reviewCutoffStatus, fullLogOpen }: ActiveWorkspaceProps) {
  const { phases, phaseMap } = useWorkflowMeta()
  const phaseOrder = phases.map((phase) => phase.id)
  const phaseMeta = phaseMap[selectedPhase]
  const errorOccurrences = useMemo(() => getTicketErrorOccurrences(ticket), [ticket])
  const explicitErrorOccurrence = selectedErrorOccurrenceId != null
    ? errorOccurrences.find((occurrence) => occurrence.id === selectedErrorOccurrenceId) ?? null
    : null
  const liveErrorOccurrence = ticket.status === 'BLOCKED_ERROR' && selectedPhase === ticket.status
    ? getActiveErrorOccurrence(ticket)
    : null
  const activeErrorOccurrence = explicitErrorOccurrence ?? liveErrorOccurrence
  const isViewingPast = isReviewablePhase(selectedPhase, ticket.status, phaseOrder, reviewCutoffStatus, ticket.visitedStatuses ?? [])
  const isLiveErrorOccurrence = Boolean(
    activeErrorOccurrence
    && liveErrorOccurrence
    && activeErrorOccurrence.id === liveErrorOccurrence.id
    && activeErrorOccurrence.resolvedAt === null,
  )
  useEffect(() => {
    const preload = () => { void importPhaseReviewView() }
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(preload, { timeout: 2_000 })
      return () => window.cancelIdleCallback?.(id)
    }
    const id = globalThis.setTimeout(preload, 0)
    return () => globalThis.clearTimeout(id)
  }, [])
  let content: React.ReactNode

  if (fullLogOpen) {
    content = <FullLogView ticket={ticket} />
  } else if (activeErrorOccurrence) {
    content = <ErrorView ticket={ticket} occurrence={activeErrorOccurrence} readOnly={!isLiveErrorOccurrence} />
  } else if (selectedPhase === 'GENERATING_EXECUTION_SETUP_PLAN') {
    // Keep setup-plan drafting on the artifact-and-log review surface even if
    // older workflow metadata is briefly cached while the application updates.
    content = <PhaseReviewView phase={selectedPhase} ticket={ticket} />
  } else if (isViewingPast) {
    const pastPhaseMeta = phaseMap[selectedPhase]
    if (selectedPhase === 'CODING') {
      content = <CodingView ticket={ticket} readOnly />
    } else if (pastPhaseMeta?.uiView === 'manual_qa') {
      content = <ManualQAView ticket={ticket} readOnly />
    } else if (
      selectedPhase === 'WAITING_EXECUTION_SETUP_APPROVAL'
      && ticket.status === 'PREPARING_EXECUTION_ENV'
      && pastPhaseMeta?.uiView === 'approval'
      && pastPhaseMeta.reviewArtifactType
      && pastPhaseMeta.reviewArtifactType !== 'manual_qa_checklist'
    ) {
      content = <ApprovalView ticket={ticket} phase={selectedPhase} artifactType={pastPhaseMeta.reviewArtifactType} />
    } else if (
      selectedPhase === 'WAITING_EXECUTION_SETUP_APPROVAL'
      && pastPhaseMeta?.uiView === 'approval'
      && pastPhaseMeta.reviewArtifactType
      && pastPhaseMeta.reviewArtifactType !== 'manual_qa_checklist'
    ) {
      content = <ApprovalView ticket={ticket} phase={selectedPhase} artifactType={pastPhaseMeta.reviewArtifactType} readOnly />
    } else if (
      pastPhaseMeta?.uiView === 'approval'
      && pastPhaseMeta.reviewArtifactType
      && pastPhaseMeta.reviewArtifactType !== 'manual_qa_checklist'
      && isBeforeExecution(ticket.status, previousStatus)
    ) {
      content = <ApprovalView ticket={ticket} phase={selectedPhase} artifactType={pastPhaseMeta.reviewArtifactType} />
    } else {
      content = <PhaseReviewView phase={selectedPhase} ticket={ticket} />
    }
  } else {
    switch (phaseMeta?.uiView) {
      case 'draft':
        content = <DraftView ticket={ticket} />
        break
      case 'interview_qa':
        content = <InterviewQAView ticket={ticket} />
        break
      case 'approval':
        content = phaseMeta.reviewArtifactType && phaseMeta.reviewArtifactType !== 'manual_qa_checklist'
          ? <ApprovalView ticket={ticket} phase={selectedPhase} artifactType={phaseMeta.reviewArtifactType} />
          : <PhaseReviewView phase={selectedPhase} ticket={ticket} />
        break
      case 'phase_review':
        content = <PhaseReviewView phase={selectedPhase} ticket={ticket} />
        break
      case 'coding':
        content = <CodingView ticket={ticket} />
        break
      case 'manual_qa':
        content = <ManualQAView ticket={ticket} />
        break
      case 'error':
        content = <ErrorView ticket={ticket} />
        break
      case 'done':
        content = <CodingView ticket={ticket} />
        break
      case 'canceled':
        content = <CanceledView ticket={ticket} />
        break
      case 'council':
      default:
        content = <CouncilView phase={selectedPhase} ticket={ticket} />
        break
    }
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground">Loading…</div>}>
        {content}
      </Suspense>
    </div>
  )
}
