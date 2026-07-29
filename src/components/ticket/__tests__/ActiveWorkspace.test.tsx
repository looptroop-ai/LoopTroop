import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { makeTicket } from '@/test/factories'
import { renderWithProviders } from '@/test/renderHelpers'
import { ActiveWorkspace } from '../ActiveWorkspace'
import { preloadWorkspaceForView } from '../workspacePreload'

vi.mock('@/components/workspace/DraftView', () => ({
  DraftView: () => <div>draft view</div>,
}))

vi.mock('@/components/workspace/CouncilView', () => ({
  CouncilView: () => <div>council view</div>,
}))

vi.mock('@/components/workspace/InterviewQAView', () => ({
  InterviewQAView: () => <div>interview view</div>,
}))

vi.mock('@/components/workspace/ApprovalView', () => ({
  ApprovalView: ({ readOnly }: { readOnly?: boolean }) => <div>approval view:{readOnly ? 'readonly' : 'live'}</div>,
}))

vi.mock('@/components/workspace/CodingView', () => ({
  CodingView: () => <div>coding view</div>,
}))

vi.mock('@/components/workspace/ErrorView', () => ({
  ErrorView: ({
    occurrence,
    readOnly,
  }: {
    occurrence?: { id: string } | null
    readOnly?: boolean
  }) => (
    <div>error view:{occurrence?.id ?? 'live'}:{readOnly ? 'readonly' : 'live'}</div>
  ),
}))

vi.mock('@/components/workspace/CanceledView', () => ({
  CanceledView: () => <div>canceled view</div>,
}))

vi.mock('@/components/workspace/PhaseReviewView', () => ({
  PhaseReviewView: ({ phase }: { phase: string }) => <div>review:{phase}</div>,
}))

vi.mock('@/components/workspace/ManualQAView', () => ({
  ManualQAView: ({ readOnly }: { readOnly?: boolean }) => <div>manual qa view:{readOnly ? 'readonly' : 'live'}</div>,
}))

vi.mock('@/hooks/useTicketArtifacts', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTicketArtifacts')>('@/hooks/useTicketArtifacts')
  return {
    ...actual,
    useTicketArtifacts: () => ({ artifacts: [], isLoading: false }),
  }
})

describe('ActiveWorkspace', () => {
  it('preloads the module matching the selected ticket workspace', async () => {
    await expect(preloadWorkspaceForView('approval')).resolves.toMatchObject({ default: expect.any(Function) })
    await expect(preloadWorkspaceForView('coding')).resolves.toMatchObject({ default: expect.any(Function) })
  })

  it('renders the selected workspace inside a constrained flex container', async () => {
    const { container } = renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'WAITING_BEADS_APPROVAL' })}
        selectedPhase="WAITING_BEADS_APPROVAL"
        previousStatus="VERIFYING_BEADS_COVERAGE"
      />,
    )

    expect(container.firstElementChild).toHaveClass('flex-1', 'min-h-0', 'overflow-hidden')
    expect(await screen.findByText('approval view:live')).toBeInTheDocument()
  })

  it('opens execution setup approval as editable while runtime setup can still rewind', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'PREPARING_EXECUTION_ENV' })}
        selectedPhase="WAITING_EXECUTION_SETUP_APPROVAL"
        previousStatus="WAITING_EXECUTION_SETUP_APPROVAL"
      />,
    )

    expect(await screen.findByText('approval view:live')).toBeInTheDocument()
  })

  it('opens execution setup approval read-only after runtime setup has advanced', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'CODING' })}
        selectedPhase="WAITING_EXECUTION_SETUP_APPROVAL"
        previousStatus="PREPARING_EXECUTION_ENV"
      />,
    )

    expect(await screen.findByText('approval view:readonly')).toBeInTheDocument()
  })

  it('keeps live execution setup approval editable while it is current', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' })}
        selectedPhase="WAITING_EXECUTION_SETUP_APPROVAL"
        previousStatus="PRE_FLIGHT_CHECK"
      />,
    )

    expect(await screen.findByText('approval view:live')).toBeInTheDocument()
  })

  it('renders execution setup drafting on the artifact-and-log review surface', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'GENERATING_EXECUTION_SETUP_PLAN' })}
        selectedPhase="GENERATING_EXECUTION_SETUP_PLAN"
        previousStatus="PRE_FLIGHT_CHECK"
      />,
    )

    expect(await screen.findByText('review:GENERATING_EXECUTION_SETUP_PLAN')).toBeInTheDocument()
    expect(screen.queryByText(/approval view/i)).not.toBeInTheDocument()
  })

  it('opens live error mode when the ticket is currently blocked', async () => {
    const ticket = makeTicket({ status: 'BLOCKED_ERROR' })
    ticket.errorOccurrences = [
      {
        id: 'err-live',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'The runner crashed.',
        errorCodes: [],
        occurredAt: '2026-03-11T10:15:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      },
    ]
    ticket.activeErrorOccurrenceId = 'err-live'

    renderWithProviders(
      <ActiveWorkspace
        ticket={ticket}
        selectedPhase="BLOCKED_ERROR"
        selectedErrorOccurrenceId="err-live"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
      />,
    )

    expect(await screen.findByText(/error view:err-live(:live|:readonly)?|Blocked — Error/)).toBeInTheDocument()
  })

  it('opens read-only error review mode for a resolved error occurrence', async () => {
    const ticket = makeTicket({ status: 'CANCELED' })
    ticket.errorOccurrences = [
      {
        id: 'err-1',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'The runner crashed.',
        errorCodes: [],
        occurredAt: '2026-03-11T10:15:00.000Z',
        resolvedAt: '2026-03-11T10:20:00.000Z',
        resolutionStatus: 'RETRIED',
        resumedToStatus: 'REFINING_PRD',
      },
    ]
    ticket.hasPastErrors = true

    renderWithProviders(
      <ActiveWorkspace
        ticket={ticket}
        selectedPhase="CODING"
        selectedErrorOccurrenceId="err-1"
        previousStatus="BLOCKED_ERROR"
        reviewCutoffStatus="CODING"
      />,
    )

    expect(await screen.findByText(/error view:err-1(:live|:readonly)?|Error Review/)).toBeInTheDocument()
  })

  it('renders the live Manual QA workspace', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'WAITING_MANUAL_QA' })}
        selectedPhase="WAITING_MANUAL_QA"
      />,
    )

    expect(await screen.findByText('manual qa view:live')).toBeInTheDocument()
  })

  it('renders Manual QA preparation as an artifact-and-log producer workspace', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'GENERATING_QA_CHECKLIST' })}
        selectedPhase="GENERATING_QA_CHECKLIST"
      />,
    )

    expect(await screen.findByText('coding view')).toBeInTheDocument()
    expect(screen.queryByText(/manual qa view/i)).not.toBeInTheDocument()
  })

  it('reviews completed Manual QA preparation separately from the live checklist', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'WAITING_MANUAL_QA', visitedStatuses: ['GENERATING_QA_CHECKLIST'] })}
        selectedPhase="GENERATING_QA_CHECKLIST"
      />,
    )

    expect(await screen.findByText('review:GENERATING_QA_CHECKLIST')).toBeInTheDocument()
    expect(screen.queryByText(/manual qa view/i)).not.toBeInTheDocument()
  })

  it('keeps a visited Manual QA round selectable after failures return to coding', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'CODING', visitedStatuses: ['WAITING_MANUAL_QA'] })}
        selectedPhase="WAITING_MANUAL_QA"
      />,
    )

    expect(await screen.findByText('manual qa view:readonly')).toBeInTheDocument()
  })

  it('keeps a visited Manual QA round reviewable after a later cancellation', async () => {
    renderWithProviders(
      <ActiveWorkspace
        ticket={makeTicket({ status: 'CANCELED', visitedStatuses: ['WAITING_MANUAL_QA', 'CODING'] })}
        selectedPhase="WAITING_MANUAL_QA"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
      />,
    )

    expect(await screen.findByText('manual qa view:readonly')).toBeInTheDocument()
  })
})
