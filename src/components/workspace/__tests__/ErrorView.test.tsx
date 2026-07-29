import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { makeTicket } from '@/test/factories'
import { ErrorView } from '../ErrorView'
import {
  BEAD_AGENT_RESPONSE_INVALID,
  BEAD_FINALIZATION_FAILED,
  BEAD_ITERATION_TIMEOUT,
  BEAD_RETRY_BUDGET_EXHAUSTED,
  FINAL_TEST_FAILED,
  OPENCODE_PROVIDER_ERROR,
} from '@shared/errorCodes'

const logSectionMock = vi.hoisted(() => vi.fn(() => <div data-testid="phase-log-section" />))
const mockUseTicketAction = vi.hoisted(() => vi.fn())
const mockUseCancelTicket = vi.hoisted(() => vi.fn())

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: logSectionMock,
}))

vi.mock('@/hooks/useTickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTickets')>()
  return {
    ...actual,
    useTicketAction: () => mockUseTicketAction(),
    useCancelTicket: () => mockUseCancelTicket(),
  }
})

function makeLiveCodingErrorTicket() {
  return makeTicket({
    status: 'BLOCKED_ERROR',
    previousStatus: 'CODING',
    availableActions: ['retry', 'cancel'],
    activeErrorOccurrenceId: 'coding-error',
    errorOccurrences: [{
      id: 'coding-error',
      occurrenceNumber: 1,
      blockedFromStatus: 'CODING',
      errorMessage: 'Implementation failed.',
      errorCodes: [],
      occurredAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
      resolutionStatus: null,
      resumedToStatus: null,
    }],
  })
}

describe('ErrorView', () => {
  beforeEach(() => {
    logSectionMock.mockClear()
    mockUseTicketAction.mockReturnValue({ mutate: vi.fn(), isPending: false })
    mockUseCancelTicket.mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it.each([
    [BEAD_AGENT_RESPONSE_INVALID, 'CODING', 'Agent response incomplete'],
    [BEAD_ITERATION_TIMEOUT, 'CODING', 'Implementation attempt timed out'],
    [OPENCODE_PROVIDER_ERROR, 'CODING', 'Provider or environment unavailable'],
    [BEAD_RETRY_BUDGET_EXHAUSTED, 'CODING', 'Implementation retries exhausted'],
    [BEAD_FINALIZATION_FAILED, 'CODING', 'Git finalization failed'],
    [FINAL_TEST_FAILED, 'RUNNING_FINAL_TEST', 'Final Testing failed'],
  ])('explains %s using its stable workflow cause', (errorCode, blockedFromStatus, expectedTitle) => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: blockedFromStatus,
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: `error-${errorCode}`,
      errorOccurrences: [{
        id: `error-${errorCode}`,
        occurrenceNumber: 1,
        blockedFromStatus,
        errorMessage: 'Low-level failure detail',
        errorCodes: [errorCode],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByRole('heading', { name: expectedTitle })).toBeInTheDocument()
    expect(screen.getByText(/^Recommended:/)).toBeInTheDocument()
    expect(screen.getByText('Technical details')).toBeInTheDocument()
  })

  it('uses the failed workflow phase for workspace setup errors without guessing from logs', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      activeErrorOccurrenceId: 'setup-failure',
      errorOccurrences: [{
        id: 'setup-failure',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Opaque low-level detail',
        errorCodes: [],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByRole('heading', { name: 'Workspace setup failed' })).toBeInTheDocument()
  })

  it('identifies operational failures from workspace setup drafting', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'GENERATING_EXECUTION_SETUP_PLAN',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: 'setup-drafting-failure',
      errorOccurrences: [{
        id: 'setup-drafting-failure',
        occurrenceNumber: 1,
        blockedFromStatus: 'GENERATING_EXECUTION_SETUP_PLAN',
        errorMessage: 'Provider request failed.',
        errorCodes: [],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByRole('heading', { name: 'Workspace setup drafting failed' })).toBeInTheDocument()
    expect(screen.getByText(/retry the drafting phase/i)).toBeInTheDocument()
  })

  it('requires confirmation before canceling a blocked ticket', () => {
    const cancelMutate = vi.fn()
    mockUseCancelTicket.mockReturnValue({ mutate: cancelMutate, isPending: false })
    const ticket = makeLiveCodingErrorTicket()

    renderWithProviders(<ErrorView ticket={ticket} />)

    fireEvent.click(screen.getByRole('button', { name: /cancel…/i }))
    expect(cancelMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Cancel Ticket')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Ticket' }))
    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: { deleteContent: false, deleteLog: false, deleteTicket: false },
    })
  })

  it('allows long error details to scroll within the summary area', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      errorMessage: 'A'.repeat(4000),
      availableActions: ['retry', 'cancel'],
    })

    const { container } = renderWithProviders(<ErrorView ticket={ticket} />)
    const root = container.firstElementChild as HTMLElement
    const summary = root.firstElementChild as HTMLElement

    expect(root).toHaveClass('min-h-0')
    expect(summary).toHaveClass('min-h-0', 'shrink', 'overflow-y-auto')
    expect(screen.getByTestId('phase-log-section')).toBeInTheDocument()
  })

  it('starts the error log drawer collapsed at the bottom', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    const firstLogSectionProps = (logSectionMock.mock.calls[0] as [unknown] | undefined)?.[0]
    expect(firstLogSectionProps).toMatchObject({
      phase: 'CODING',
      defaultExpanded: false,
    })
  })

  it('shows each append-only bead note history under its own heading', () => {
    const base = makeLiveCodingErrorTicket()
    const ticket = makeTicket({
      ...base,
      runtime: {
        ...base.runtime,
        lastFailedBeadId: 'bead-1',
        beads: [{
          id: 'bead-1',
          title: 'Failed bead',
          status: 'failed',
          iteration: 2,
          failedIterationNotes: [{ timestamp: '2026-01-01T00:00:00.000Z', iteration: 1, content: 'iteration failed' }],
          userRetryNotes: [{ timestamp: '2026-01-01T00:01:00.000Z', iteration: 2, content: 'try the alternate path' }],
          finalizationFailureNotes: [{ timestamp: '2026-01-01T00:02:00.000Z', iteration: 2, content: 'commit failed', errorCode: 'COMMIT_FAILED' }],
        }],
      },
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Failed Iteration Notes')).toBeInTheDocument()
    expect(screen.getByText('User Retry Notes')).toBeInTheDocument()
    expect(screen.getByText('Finalization Failure Notes')).toBeInTheDocument()
    expect(screen.getByText('iteration failed')).toBeInTheDocument()
    expect(screen.getByText('try the alternate path')).toBeInTheDocument()
    expect(screen.getByText('commit failed')).toBeInTheDocument()
  })

  it('shows a coding-specific retry label when the active error exhausted the bead retry budget', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: '1',
      errorOccurrences: [{
        id: '1',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'Bead used its retry budget.',
        errorCodes: [BEAD_RETRY_BUDGET_EXHAUSTED],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
      runtime: {
        ...makeTicket().runtime,
        maxIterationsPerBead: 5,
      },
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByRole('button', { name: 'Try again 5 retries' })).toBeInTheDocument()
  })

  it('keeps the generic retry label for non-budget blocked errors', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: '2',
      errorOccurrences: [{
        id: '2',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'Lint failed.',
        errorCodes: ['LINT_FAILED'],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
      runtime: {
        ...makeTicket().runtime,
        maxIterationsPerBead: 5,
      },
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('offers an extra-note retry only for a live retryable implementation error', () => {
    const liveView = renderWithProviders(<ErrorView ticket={makeLiveCodingErrorTicket()} />)

    expect(screen.getByRole('button', { name: 'Retry with extra note...' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    liveView.unmount()

    const nonCodingTicket = makeTicket({
      ...makeLiveCodingErrorTicket(),
      previousStatus: 'GENERATING_PRD',
      errorOccurrences: [{
        ...makeLiveCodingErrorTicket().errorOccurrences![0]!,
        blockedFromStatus: 'GENERATING_PRD',
      }],
    })
    const nonCodingView = renderWithProviders(<ErrorView ticket={nonCodingTicket} />)
    expect(screen.queryByRole('button', { name: 'Retry with extra note...' })).not.toBeInTheDocument()
    nonCodingView.unmount()

    const historyView = renderWithProviders(<ErrorView ticket={makeLiveCodingErrorTicket()} readOnly />)
    expect(screen.queryByRole('button', { name: 'Retry with extra note...' })).not.toBeInTheDocument()
    historyView.unmount()

    const noRetryTicket = makeLiveCodingErrorTicket()
    noRetryTicket.availableActions = ['cancel']
    renderWithProviders(<ErrorView ticket={noRetryTicket} />)
    expect(screen.queryByRole('button', { name: 'Retry with extra note...' })).not.toBeInTheDocument()
  })

  it('offers setup recovery actions for a live workspace runtime setup error', () => {
    const mutate = vi.fn()
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: 'setup-error',
      errorOccurrences: [{
        id: 'setup-error',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Workspace probe failed.',
        errorCodes: ['EXECUTION_SETUP_FAILED'],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    const editSetupPlanButton = screen.getByRole('button', { name: 'Edit setup plan...' })
    const retryWithNoteButton = screen.getByRole('button', { name: 'Retry with extra note...' })
    const retryButton = screen.getByRole('button', { name: 'Retry' })
    expect(editSetupPlanButton.compareDocumentPosition(retryWithNoteButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(retryWithNoteButton.compareDocumentPosition(retryButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(retryWithNoteButton)
    expect(screen.getByRole('dialog', { name: 'Retry workspace setup with an extra note' })).toBeInTheDocument()
    expect(screen.getByText(/sends only this note and runs one extra attempt/i)).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(editSetupPlanButton)
    expect(screen.getByRole('dialog', { name: 'Edit workspace setup plan?' })).toBeInTheDocument()
    expect(screen.getByText(/failed setup attempt will remain in the ticket history/i)).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup plan' }))
    expect(mutate).toHaveBeenCalledWith(
      { id: ticket.id, action: 'edit_execution_setup_plan' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
  })

  it('removes terminal formatting from setup failure details', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      activeErrorOccurrenceId: 'setup-error',
      errorOccurrences: [{
        id: 'setup-error',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Execution setup failed',
        errorCodes: ['\u001b[31mFAIL\u001b[39m src/example.test.ts\nError: Cannot resolve package\n  at src/example.test.ts:2:1'],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    const detail = screen.getByText((_, element) => (
      element?.classList.contains('whitespace-pre-wrap') === true
      && element.textContent === [
        'FAIL src/example.test.ts',
        'Error: Cannot resolve package',
        '  at src/example.test.ts:2:1',
      ].join('\n')
    ))
    expect(detail).toHaveClass('whitespace-pre-wrap')
    expect(detail.textContent).toContain('\nError: Cannot resolve package\n')
    expect(document.body.textContent).not.toContain('\u001b')
  })

  it('cleans terminal formatting and duplicate warnings from the displayed error', () => {
    const ticket = makeLiveCodingErrorTicket()
    ticket.errorOccurrences![0]!.errorMessage = [
      '\u001b[33mExperimental warning\u001b[39m',
      '\u001b[33mExperimental warning\u001b[39m',
      '\u001b[31m──────\u001b[39m',
      '\u001b[41m FAIL \u001b[49m src/example.test.ts',
    ].join('\r\n')

    renderWithProviders(<ErrorView ticket={ticket} />)

    const displayedError = screen.getByText(/Experimental warning/)
    expect(displayedError).toHaveTextContent('Experimental warning FAIL src/example.test.ts')
    expect(displayedError.textContent?.match(/Experimental warning/g)).toHaveLength(1)
    expect(screen.queryByText(/───/)).not.toBeInTheDocument()
  })

  it('opens an accessible extra-note dialog and requires non-whitespace text', () => {
    renderWithProviders(<ErrorView ticket={makeLiveCodingErrorTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry with extra note...' }))
    const dialog = screen.getByRole('dialog', { name: 'Retry implementation with an extra note' })
    const note = within(dialog).getByRole('textbox', { name: /Extra note/ })
    const submit = within(dialog).getByRole('button', { name: 'Add note and retry' })

    expect(note).toHaveAttribute('required')
    expect(note).toHaveAttribute('maxLength', '20000')
    expect(submit).toBeDisabled()

    fireEvent.change(note, { target: { value: '   \n  ' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter an extra note before retrying.')
    expect(submit).toBeDisabled()

    fireEvent.change(note, { target: { value: 'A'.repeat(20_001) } })
    expect(note).toHaveValue('A'.repeat(20_000))
    expect(within(dialog).getByText('20,000 / 20,000 characters')).toBeInTheDocument()
    expect(submit).toBeEnabled()
  })

  it('submits the exact extra note and clears it only after retry succeeds', () => {
    const mutate = vi.fn((_: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.()
    })
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    const ticket = makeLiveCodingErrorTicket()
    renderWithProviders(<ErrorView ticket={ticket} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry with extra note...' }))
    const note = screen.getByRole('textbox', { name: /Extra note/ })
    const exactNote = '  Keep the existing parser.\nTry the smaller repair first.  '
    fireEvent.change(note, { target: { value: exactNote } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note and retry' }))

    expect(mutate).toHaveBeenCalledWith(
      { id: ticket.id, action: 'retry', note: exactNote },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry with extra note...' }))
    expect(screen.getByRole('textbox', { name: /Extra note/ })).toHaveValue('')
  })

  it('keeps the extra-note dialog and text when retry fails', () => {
    const mutate = vi.fn((_: unknown, options?: { onError?: (error: Error) => void }) => {
      options?.onError?.(new Error('The implementation bead could not be reset'))
    })
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    renderWithProviders(<ErrorView ticket={makeLiveCodingErrorTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry with extra note...' }))
    const note = screen.getByRole('textbox', { name: /Extra note/ })
    fireEvent.change(note, { target: { value: 'Preserve this note after failure.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note and retry' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(note).toHaveValue('Preserve this note after failure.')
    expect(screen.getByRole('alert')).toHaveTextContent('The implementation bead could not be reset')
  })

  it('disables the extra-note form while the retry request is pending', () => {
    const mutate = vi.fn()
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    const ticket = makeLiveCodingErrorTicket()
    renderWithProviders(<ErrorView ticket={ticket} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry with extra note...' }))
    const note = screen.getByRole('textbox', { name: /Extra note/ })
    fireEvent.change(note, {
      target: { value: 'Wait for this request.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add note and retry' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: /Extra note/ })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Add note and retry' })).toBeDisabled()
  })

  it('shows real bead counters on coding error occurrence labels', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: 'bead-counts',
      errorOccurrences: [{
        id: 'bead-counts',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'Bead execution failed.',
        errorCodes: [],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
      runtime: {
        ...makeTicket().runtime,
        currentBead: 2,
        totalBeads: 5,
      },
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Error 1 — Implementing (Bead 2/5)')).toBeInTheDocument()
    expect(screen.getByText('Blocked from Implementing (Bead 2/5)')).toBeInTheDocument()
    expect(screen.queryByText(/Bead \?\/\?/)).not.toBeInTheDocument()
  })

  it('shows Continue only when the live blocked ticket exposes the continue action', () => {
    const mutate = vi.fn()
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      availableActions: ['retry', 'continue', 'cancel'],
      activeErrorOccurrenceId: 'continue-1',
      errorOccurrences: [{
        id: 'continue-1',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Usage limit reached.',
        errorCodes: [],
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'usage limit reached',
          sessionId: 'ses-continue',
          statusCode: 429,
          isRetryable: true,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText(/sends only "continue please"/i)).toBeInTheDocument()
    expect(mutate).toHaveBeenCalledWith(
      { id: ticket.id, action: 'continue' },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
  })

  it('shows a paused coding bead cue for continuable provider interruptions', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      availableActions: ['retry', 'continue', 'cancel'],
      activeErrorOccurrenceId: 'coding-paused',
      errorOccurrences: [{
        id: 'coding-paused',
        occurrenceNumber: 1,
        blockedFromStatus: 'CODING',
        errorMessage: 'OpenCode retry grace window expired.',
        errorCodes: ['OPENCODE_PROVIDER_ERROR'],
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'usage limit reached',
          sessionId: 'ses-coding',
          statusCode: 429,
          isRetryable: true,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
      runtime: {
        ...makeTicket().runtime,
        activeBeadId: 'bead-9',
        activeBeadIteration: 6,
        beads: [{
          id: 'bead-9',
          title: 'Provider-limited bead',
          status: 'in_progress',
          iteration: 6,
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
        }],
      },
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByText('bead-9')).toBeInTheDocument()
    expect(screen.getByText(/Timer paused while the ticket is blocked/)).toHaveTextContent(
      'Continue resumes the preserved OpenCode session with a fresh bead timer.',
    )
    expect(screen.getByRole('button', { name: 'Retry with extra note...' })).toBeInTheDocument()
    expect(screen.queryByText(/Failed bead/)).not.toBeInTheDocument()
  })

  it('shows action errors inline when Continue is rejected', async () => {
    const mutate = vi.fn((_: unknown, options?: { onError?: (error: Error) => void }) => {
      options?.onError?.(new Error('Continue is not available because the preserved OpenCode session is no longer active'))
    })
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false })
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      availableActions: ['retry', 'continue', 'cancel'],
      activeErrorOccurrenceId: 'continue-rejected',
      errorOccurrences: [{
        id: 'continue-rejected',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Usage limit reached.',
        errorCodes: [],
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'usage limit reached',
          sessionId: 'ses-continue',
          statusCode: 429,
          isRetryable: true,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Continue is not available because the preserved OpenCode session is no longer active')
  })

  it('hides Continue when the live blocked ticket does not expose the continue action', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      availableActions: ['retry', 'cancel'],
      activeErrorOccurrenceId: 'retry-only',
      errorOccurrences: [{
        id: 'retry-only',
        occurrenceNumber: 1,
        blockedFromStatus: 'PREPARING_EXECUTION_ENV',
        errorMessage: 'Invalid request.',
        errorCodes: [],
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
  })

  it('renders structured blocked-error diagnostics when present', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'SCANNING_RELEVANT_FILES',
      activeErrorOccurrenceId: 'diag-1',
      errorOccurrences: [{
        id: 'diag-1',
        occurrenceNumber: 1,
        blockedFromStatus: 'SCANNING_RELEVANT_FILES',
        errorMessage: 'Relevant files scan failed validation after 1 structured retry attempt(s).',
        errorCodes: ['RELEVANT_FILES_SCAN_FAILED', 'OPENCODE_PROVIDER_AUTH_FAILED'],
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'invalid_request_error: Your authentication token has been invalidated. Please try signing in again. (HTTP 401)',
          modelId: 'openai/gpt-5.3-codex',
          sessionId: 'ses-auth',
          providerId: 'openai',
          providerModelId: 'gpt-5.3-codex',
          statusCode: 401,
          providerErrorType: 'invalid_request_error',
          providerErrorMessage: 'Your authentication token has been invalidated. Please try signing in again.',
          isRetryable: false,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Underlying error')).toBeInTheDocument()
    expect(screen.getByText(/invalid_request_error: Your authentication token has been invalidated/)).toBeInTheDocument()
    expect(screen.getByText('HTTP:')).toBeInTheDocument()
    expect(screen.getByText('401')).toBeInTheDocument()
    expect(screen.getByText('Provider:')).toBeInTheDocument()
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('Provider model:')).toBeInTheDocument()
    expect(screen.getByText('Provider type:')).toBeInTheDocument()
    expect(screen.getByText('invalid_request_error')).toBeInTheDocument()
    expect(screen.getByText('Retryable:')).toBeInTheDocument()
    expect(screen.getByText('no')).toBeInTheDocument()
  })

  it('renders model output truncation diagnostics with finish reason and token counts', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'VERIFYING_PRD_COVERAGE',
      activeErrorOccurrenceId: 'diag-length',
      errorOccurrences: [{
        id: 'diag-length',
        occurrenceNumber: 1,
        blockedFromStatus: 'VERIFYING_PRD_COVERAGE',
        errorMessage: 'PRD coverage resolution output failed validation after 1 structured retry attempt(s): PRD is missing epics',
        errorCodes: ['COVERAGE_FAILED', 'OPENCODE_OUTPUT_TRUNCATED'],
        diagnostics: {
          kind: 'model_output_truncated',
          source: 'opencode',
          summary: 'The model stopped because OpenCode reported finish reason "length", which usually means the response reached the model or provider output length limit.',
          modelId: 'opencode-go/deepseek-v4-flash',
          sessionId: 'ses-length',
          finishReason: 'length',
          outputTokens: 2923,
          reasoningTokens: 29077,
          inputTokens: 13252,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Underlying error')).toBeInTheDocument()
    expect(screen.getByText('Model Output Truncated')).toBeInTheDocument()
    expect(screen.getByText('Finish reason:')).toBeInTheDocument()
    expect(screen.getByText('length')).toBeInTheDocument()
    expect(screen.getByText('Output tokens:')).toBeInTheDocument()
    expect(screen.getByText('2,923')).toBeInTheDocument()
    expect(screen.getByText('Reasoning tokens:')).toBeInTheDocument()
    expect(screen.getByText('29,077')).toBeInTheDocument()
  })

  it('does not repeat the diagnostic summary when it already appears in the primary error', () => {
    const duplicateMessage = 'Coverage output failed validation after 1 structured retry attempt(s): No coverage result content found'
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'VERIFYING_PRD_COVERAGE',
      activeErrorOccurrenceId: 'diag-duplicate',
      errorOccurrences: [{
        id: 'diag-duplicate',
        occurrenceNumber: 1,
        blockedFromStatus: 'VERIFYING_PRD_COVERAGE',
        errorMessage: duplicateMessage,
        errorCodes: ['COVERAGE_FAILED'],
        diagnostics: {
          kind: 'runtime',
          source: 'opencode',
          summary: duplicateMessage,
        },
        occurredAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolutionStatus: null,
        resumedToStatus: null,
      }],
    })

    renderWithProviders(<ErrorView ticket={ticket} />)

    expect(screen.getByText('Underlying error')).toBeInTheDocument()
    expect(screen.getAllByText(duplicateMessage)).toHaveLength(1)
    expect(screen.getByText('Kind:')).toBeInTheDocument()
    expect(screen.getByText('Runtime')).toBeInTheDocument()
  })

  it('omits milliseconds from occurrence timestamps', () => {
    const occurrence = {
      id: '3',
      occurrenceNumber: 1,
      blockedFromStatus: 'CODING',
      errorMessage: 'Workspace setup timed out.',
      errorCodes: [],
      occurredAt: '2026-01-01T00:00:00.123Z',
      resolvedAt: '2026-01-01T00:01:00.456Z',
      resolutionStatus: 'RETRIED' as const,
      resumedToStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
    }
    const ticket = makeTicket({
      status: 'CANCELED',
      previousStatus: 'BLOCKED_ERROR',
      errorOccurrences: [occurrence],
      activeErrorOccurrenceId: null,
    })

    renderWithProviders(<ErrorView ticket={ticket} occurrence={occurrence} readOnly />)

    const blockedLabel = screen.getByText(/Blocked from /)
    expect(blockedLabel).toHaveAttribute('title')
    expect(blockedLabel.getAttribute('title')).not.toContain('.123')

    const resolvedLabel = screen.getByText(/Resolved /)
    expect(resolvedLabel).not.toHaveTextContent('.456')
  })
})
