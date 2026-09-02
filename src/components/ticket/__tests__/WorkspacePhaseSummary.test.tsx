import type { ReactElement } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogContextValue, LogEntry } from '@/context/logUtils'
import { TEST, makeTicket } from '@/test/factories'
import { renderWithProviders, createTestQueryClient, createJsonResponse, withLogContext } from '@/test/renderHelpers'
import { WorkspacePhaseSummary } from '../WorkspacePhaseSummary'

function createLogEntry(line: string, timestamp: string): LogEntry {
  return {
    id: `${timestamp}:${line}`,
    entryId: `${timestamp}:${line}`,
    line,
    source: 'system',
    status: 'VERIFYING_PRD_COVERAGE',
    timestamp,
    audience: 'all',
    kind: 'milestone',
    streaming: false,
    op: 'append',
  }
}

function renderWithLogContext(ui: ReactElement, logsByPhase: Record<string, LogEntry[]>) {
  const value: LogContextValue = {
    logsByPhase,
    activePhase: null,
    isLoadingLogs: false,
    addLog: vi.fn(),
    addLogRecord: vi.fn(),
    getLogsForPhase: (phase: string, options?: { phaseAttempt?: number }) => {
      const logs = logsByPhase[phase] ?? []
      if (options?.phaseAttempt !== undefined) {
        return logs.filter(e => e.phaseAttempt === options.phaseAttempt)
      }
      return logs
    },
    getAllLogs: () => Object.values(logsByPhase).flat(),
    setActivePhase: vi.fn(),
    clearLogs: vi.fn(),
  }

  return renderWithProviders(
    withLogContext(value, ui),
    { queryClient: createTestQueryClient() },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input)
    if (url.includes('/attempts')) {
      return createJsonResponse([
        {
          ticketId: TEST.ticketId,
          phase: 'DRAFTING_PRD',
          attemptNumber: 1,
          state: 'active',
          archivedReason: null,
          createdAt: TEST.timestamp,
          archivedAt: null,
        },
      ])
    }
    if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
      return createJsonResponse([])
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
})

describe('WorkspacePhaseSummary', () => {
  it('renders the phase description and opens detailed status copy', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD' })

    renderWithProviders(
      <WorkspacePhaseSummary phase="DRAFTING_PRD" ticket={ticket} />,
    )

    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show detailed explanation for council drafting specs/i }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Part 1, Full Answers: For each skipped interview question/)).toBeInTheDocument()
    expect(screen.getByText(/Part 2, PRD drafting: Each model uses its own completed answer set/)).toBeInTheDocument()
    expect(screen.getByText(/Quorum Met → Voting on Specs: The workflow advances once enough valid PRDs exist to score\./)).toBeInTheDocument()
  })

  it('collapses and re-expands the description when clicking the phase name', () => {
    const ticket = makeTicket({ status: 'DRAFTING_PRD' })

    renderWithProviders(
      <WorkspacePhaseSummary phase="DRAFTING_PRD" ticket={ticket} />,
    )

    const toggle = screen.getByRole('button', { name: 'Council Drafting Specs' })
    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.queryByText(/drafting competing PRDs\./)).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()
  })

  it('shows the failed phase, actual error, and live recovery choices for a blocked error', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'REFINING_PRD',
      availableActions: ['retry', 'continue', 'cancel'],
    })

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorMessage={'The runner crashed while executing bead B-12.\n\n112 | noisy parser excerpt'}
      />,
    )

    expect(screen.getByRole('button', { name: 'Error — Refining Specs' })).toBeInTheDocument()
    expect(screen.getByText(/Refining Specs failed: The runner crashed while executing bead B-12\./)).toBeInTheDocument()
    expect(screen.getByText(/Retry starts a fresh Refining Specs attempt\./)).toBeInTheDocument()
    expect(screen.getByText(/Continue resumes the preserved provider session\./)).toBeInTheDocument()
    expect(screen.queryByText(/noisy parser excerpt/)).not.toBeInTheDocument()
    expect(screen.queryByText(/CODING exposes three separate histories/)).not.toBeInTheDocument()
  })

  it('does not advertise live recovery actions for a historical error occurrence', () => {
    const ticket = makeTicket({ status: 'CODING', availableActions: ['cancel'] })

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorOccurrence={{
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'DRAFTING_PRD',
          errorMessage: 'Provider connection closed.',
          errorCodes: [],
          occurredAt: TEST.timestamp,
          resolvedAt: TEST.timestamp,
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'DRAFTING_PRD',
        }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Past error — Council Drafting Specs' })).toBeInTheDocument()
    expect(screen.getByText(/Council Drafting Specs failed: Provider connection closed\./)).toBeInTheDocument()
    expect(screen.getByText(/This saved occurrence is read-only/)).toBeInTheDocument()
    expect(screen.queryByText(/Retry starts/)).not.toBeInTheDocument()
  })

  it('truncates oversized error payloads in the top summary', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'REFINING_PRD',
      availableActions: ['retry', 'cancel'],
    })
    const oversizedError = `Malformed provider output: ${'invalid YAML payload '.repeat(30)}`

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorMessage={oversizedError}
      />,
    )

    const summary = screen.getByText(/Refining Specs failed: Malformed provider output:/)
    expect(summary.textContent).toContain('… Retry starts a fresh Refining Specs attempt.')
    expect(summary.textContent).not.toContain(oversizedError.trim())
    expect(summary.textContent?.length).toBeLessThan(350)
  })

  it('renders with runtime defaults when cached ticket data is partial', () => {
    const ticket = {
      ...makeTicket({ status: 'CODING' }),
      runtime: undefined,
      currentBead: 2,
      totalBeads: 4,
    } as unknown as ReturnType<typeof makeTicket>

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    )

    expect(screen.getByRole('button', { name: 'Implementing (working on bead 2 of 4)' })).toBeInTheDocument()
    expect(screen.getByText(/LoopTroop is implementing the ticket one bead at a time/)).toBeInTheDocument()
  })

  it('shows live coding bead and iteration progress in the main title', () => {
    const ticket = makeTicket({
      status: 'CODING',
      runtime: {
        ...makeTicket().runtime,
        currentBead: 3,
        totalBeads: 10,
        activeBeadIteration: 2,
        maxIterationsPerBead: 5,
      },
    })

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    )

    expect(screen.getByRole('button', { name: 'Implementing (working on bead 3 of 10, iteration 2 of 5)' })).toBeInTheDocument()
  })

  it('hides live coding progress when reviewing CODING after the ticket moved on', () => {
    const ticket = makeTicket({
      status: 'RUNNING_FINAL_TEST',
      runtime: {
        ...makeTicket().runtime,
        currentBead: 3,
        totalBeads: 10,
        activeBeadIteration: 2,
        maxIterationsPerBead: 5,
      },
    })

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    )

    expect(screen.getByRole('button', { name: 'Implementing' })).toBeInTheDocument()
    expect(screen.queryByText(/working on bead/)).not.toBeInTheDocument()
  })

  it('shows the bead countdown from the active iteration update while CODING is live', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
    const runtime = {
      ...makeTicket().runtime,
      activeBeadId: 'bead-1',
      perIterationTimeoutMs: 8 * 60 * 1000,
      beads: [{
        id: 'bead-1',
        title: 'Active bead',
        status: 'in_progress',
        iteration: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      }],
    }
    const liveTicket = makeTicket({
      status: 'CODING',
      runtime,
    })

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={liveTicket} />,
    )

    expect(screen.getByText('07:00')).toBeInTheDocument()
    expect(screen.getByText('08:00')).toBeInTheDocument()
  })

  it('does not show a live bead countdown when reviewing CODING from a blocked ticket', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
    const blockedTicket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      runtime: {
        ...makeTicket().runtime,
        activeBeadId: 'bead-1',
        perIterationTimeoutMs: 8 * 60 * 1000,
        beads: [{
          id: 'bead-1',
          title: 'Paused bead',
          status: 'in_progress',
          iteration: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: null,
        }],
      },
    })

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={blockedTicket} />,
    )

    expect(screen.queryByText('06:00')).not.toBeInTheDocument()
    expect(screen.queryByText('08:00')).not.toBeInTheDocument()
  })

  it('shows the next live PRD coverage version and pass in the main title when revision work starts', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.includes('/attempts')) {
        return createJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_PRD_COVERAGE' })
    const logsByPhase = {
      VERIFYING_PRD_COVERAGE: [
        createLogEntry('[SYS] Transition: REFINING_PRD -> VERIFYING_PRD_COVERAGE', '2026-01-01T00:00:00.000Z'),
        createLogEntry('[SYS] Coverage verification started using winning model: test-vendor/test-model (run 2/5).', '2026-01-01T00:00:01.000Z'),
        createLogEntry('[SYS] Coverage found 2 gap(s) in PRD Candidate v1. Revising candidate before the next audit pass.', '2026-01-01T00:00:02.000Z'),
      ],
    }

    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      logsByPhase,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coverage Check (PRD) (checking version 2, pass 2 of 5)' })).toBeInTheDocument()
    })
  })

  it('shows the latest live beads coverage version and pass in the main title from coverage artifacts', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
        return createJsonResponse([
          {
            id: 1,
            ticketId: TEST.ticketId,
            phase: 'VERIFYING_BEADS_COVERAGE',
            artifactType: 'beads_coverage_revision',
            filePath: null,
            content: JSON.stringify({
              winnerId: TEST.councilMembers[0],
              refinedContent: 'beads: []',
              candidateVersion: 3,
              coverageRunNumber: 2,
              maxCoveragePasses: 5,
            }),
            createdAt: '2026-01-01T00:00:03.000Z',
          },
        ])
      }
      if (url.includes('/attempts')) {
        return createJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_BEADS_COVERAGE' })

    renderWithProviders(
      <WorkspacePhaseSummary phase="VERIFYING_BEADS_COVERAGE" ticket={ticket} />,
      { queryClient: createTestQueryClient() },
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coverage Check (Beads) (checking version 3, pass 2 of 5)' })).toBeInTheDocument()
    })
  })

  it('shows the live interview coverage pass without a candidate version', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
        return createJsonResponse([
          {
            id: 1,
            ticketId: TEST.ticketId,
            phase: 'VERIFYING_INTERVIEW_COVERAGE',
            phaseAttempt: 1,
            artifactType: 'interview_coverage',
            filePath: null,
            content: JSON.stringify({
              status: 'gaps',
              summary: 'Need more details.',
              coverageRunNumber: 2,
              maxCoveragePasses: 5,
            }),
            createdAt: '2026-01-01T00:00:03.000Z',
            updatedAt: '2026-01-01T00:00:03.000Z',
          },
        ])
      }
      if (url.includes('/attempts')) {
        return createJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_INTERVIEW_COVERAGE' })

    renderWithProviders(
      <WorkspacePhaseSummary phase="VERIFYING_INTERVIEW_COVERAGE" ticket={ticket} />,
      { queryClient: createTestQueryClient() },
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coverage Check (Interview) (pass 2 of 5)' })).toBeInTheDocument()
    })
  })

  it('shows the live retry attempt for manually retried phases', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/phases/REFINING_PRD/attempts`)) {
        return createJsonResponse([
          {
            ticketId: TEST.ticketId,
            phase: 'REFINING_PRD',
            attemptNumber: 2,
            state: 'active',
            archivedReason: null,
            createdAt: '2026-01-01T00:01:00.000Z',
            archivedAt: null,
          },
          {
            ticketId: TEST.ticketId,
            phase: 'REFINING_PRD',
            attemptNumber: 1,
            state: 'archived',
            archivedReason: 'manual_retry_after_blocked_error',
            createdAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-01-01T00:01:00.000Z',
          },
        ])
      }
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
        return createJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const ticket = makeTicket({ id: TEST.ticketId, status: 'REFINING_PRD' })

    renderWithProviders(
      <WorkspacePhaseSummary phase="REFINING_PRD" ticket={ticket} />,
      { queryClient: createTestQueryClient() },
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refining Specs (retry attempt 2)' })).toBeInTheDocument()
    })
  })

  it('shows the live execution setup attempt when status is PREPARING_EXECUTION_ENV', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
    const ticket = makeTicket({
      id: TEST.ticketId,
      status: 'PREPARING_EXECUTION_ENV',
      runtime: { ...makeTicket().runtime, executionSetupTimeoutMs: 20 * 60 * 1000 },
    })
    const logsByPhase = {
      PREPARING_EXECUTION_ENV: [
        {
          id: 'log-1',
          entryId: 'log-1',
          line: 'Starting execution setup attempt 2 of 5.',
          source: 'system',
          status: 'PREPARING_EXECUTION_ENV',
          timestamp: '2026-01-01T00:00:00.000Z',
          audience: 'all',
          kind: 'info',
          streaming: false,
          op: 'append',
        } as LogEntry,
      ],
    }

    renderWithLogContext(
      <WorkspacePhaseSummary phase="PREPARING_EXECUTION_ENV" ticket={ticket} />,
      logsByPhase,
    )

    expect(screen.getByRole('button', { name: 'Preparing Workspace Runtime (execution setup attempt 2 of 5)' })).toBeInTheDocument()
    expect(screen.getByText('18:00')).toBeInTheDocument()
    expect(screen.getByText('20:00')).toBeInTheDocument()
  })

  it('shows the live execution setup attempt with phase attempt label when status is PREPARING_EXECUTION_ENV', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/phases/PREPARING_EXECUTION_ENV/attempts`)) {
        return createJsonResponse([
          {
            ticketId: TEST.ticketId,
            phase: 'PREPARING_EXECUTION_ENV',
            attemptNumber: 2,
            state: 'active',
            archivedReason: null,
            createdAt: '2026-01-01T00:01:00.000Z',
            archivedAt: null,
          },
          {
            ticketId: TEST.ticketId,
            phase: 'PREPARING_EXECUTION_ENV',
            attemptNumber: 1,
            state: 'archived',
            archivedReason: 'manual_retry_after_blocked_error',
            createdAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-01-01T00:01:00.000Z',
          },
        ])
      }
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)) {
        return createJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const ticket = makeTicket({ id: TEST.ticketId, status: 'PREPARING_EXECUTION_ENV' })
    const logsByPhase = {
      PREPARING_EXECUTION_ENV: [
        {
          id: 'log-1',
          entryId: 'log-1',
          line: 'Starting execution setup attempt 3 of 5.',
          source: 'system',
          status: 'PREPARING_EXECUTION_ENV',
          timestamp: '2026-01-01T00:00:00.000Z',
          audience: 'all',
          kind: 'info',
          streaming: false,
          op: 'append',
          phaseAttempt: 2,
        } as LogEntry,
      ],
    }

    renderWithLogContext(
      <WorkspacePhaseSummary phase="PREPARING_EXECUTION_ENV" ticket={ticket} />,
      logsByPhase,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Preparing Workspace Runtime (retry attempt 2 - execution setup attempt 3 of 5)' })).toBeInTheDocument()
    })
  })
})
