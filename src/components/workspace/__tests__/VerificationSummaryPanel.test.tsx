import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTicket } from '@/test/factories'
import { TooltipProvider } from '@/components/ui/tooltip'

const useTicketArtifactsMock = vi.fn<
  () => {
    artifacts: Array<{ id: string; phase: string; artifactType: string; content: string }>
    isLoading: boolean
  }
>(() => ({ artifacts: [], isLoading: false }))

vi.mock('@/hooks/useTicketArtifacts', () => ({
  useTicketArtifacts: () => useTicketArtifactsMock(),
}))

import { VerificationSummaryPanel } from '../VerificationSummaryPanel'

function renderPanel(
  overrides: Parameters<typeof makeTicket>[0] = {},
  actions = { onMerge: vi.fn(), onCloseUnmerged: vi.fn(), isPending: false },
) {
  const ticket = makeTicket({
    status: 'WAITING_PR_REVIEW',
    branchName: 'feat/test-branch',
    ...overrides,
    runtime: {
      baseBranch: 'main',
      currentBead: 5,
      completedBeads: 5,
      totalBeads: 5,
      percentComplete: 100,
      iterationCount: 0,
      maxIterations: null,
      maxIterationsPerBead: null,
      activeBeadId: null,
      activeBeadIteration: null,
      lastFailedBeadId: null,
      artifactRoot: '/tmp/test',
      candidateCommitSha: 'abc123def456',
      preSquashHead: 'old789hash',
      finalTestStatus: 'passed',
      prNumber: 42,
      prUrl: 'https://github.com/test/repo/pull/42',
      prState: 'draft',
      prHeadSha: 'abc123def456',
      beads: [],
      ...(overrides as Record<string, unknown>).runtime as Record<string, unknown> ?? {},
    },
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <VerificationSummaryPanel ticket={ticket} {...actions} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
    ...actions,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useTicketArtifactsMock.mockReturnValue({ artifacts: [], isLoading: false })
})

afterEach(() => {
  cleanup()
})

describe('VerificationSummaryPanel', () => {
  it('renders the verification header', () => {
    renderPanel()
    expect(screen.getByText('Draft PR Review Required')).toBeTruthy()
  })

  it('shows branch name and base branch', () => {
    renderPanel()
    expect(screen.getByText('feat/test-branch')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('shows candidate commit SHA (truncated)', () => {
    renderPanel()
    expect(screen.getByText('abc123de')).toBeTruthy()
  })

  it('shows tests passed badge when finalTestStatus is passed', () => {
    renderPanel()
    expect(screen.getByText('Passed')).toBeTruthy()
  })

  it('shows tests failed badge when finalTestStatus is failed', () => {
    renderPanel({ runtime: { finalTestStatus: 'failed' } } as Parameters<typeof makeTicket>[0])
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('shows beads completion count', () => {
    renderPanel()
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('/5')).toBeTruthy()
  })

  it('calls onMerge when Merge PR & Finish is clicked', () => {
    const onMerge = vi.fn()
    renderPanel({}, { onMerge, onCloseUnmerged: vi.fn(), isPending: false })
    fireEvent.click(screen.getByText('Merge PR & Finish'))
    expect(onMerge).toHaveBeenCalledOnce()
  })

  it('confirms before finishing without merge, and carries the reason through', () => {
    const onCloseUnmerged = vi.fn()
    renderPanel({}, { onMerge: vi.fn(), onCloseUnmerged, isPending: false })

    // One click no longer ends the ticket. It opens the confirmation.
    fireEvent.click(screen.getByText('Finish Without Merge'))
    expect(onCloseUnmerged).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /finish without merging/i })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/why finish without merging/i), {
      target: { value: 'Superseded by a different branch.' },
    })
    fireEvent.click(screen.getAllByText('Finish Without Merge')[1]!)

    expect(onCloseUnmerged).toHaveBeenCalledWith('Superseded by a different branch.')
  })

  it('finishes without merge with no reason when none is given', () => {
    const onCloseUnmerged = vi.fn()
    renderPanel({}, { onMerge: vi.fn(), onCloseUnmerged, isPending: false })

    fireEvent.click(screen.getByText('Finish Without Merge'))
    fireEvent.click(screen.getAllByText('Finish Without Merge')[1]!)

    expect(onCloseUnmerged).toHaveBeenCalledWith(undefined)
  })

  it('disables buttons when isPending is true', () => {
    renderPanel({}, { onMerge: vi.fn(), onCloseUnmerged: vi.fn(), isPending: true })
    const mergeBtn = screen.getByText('Merging').closest('button')
    const closeBtn = screen.getByText('Finish Without Merge').closest('button')
    expect(mergeBtn?.disabled).toBe(true)
    expect(closeBtn?.disabled).toBe(true)
  })

  it('falls back to externalId when branchName is null', () => {
    renderPanel({ branchName: null })
    expect(screen.getByText('TEST-1')).toBeTruthy()
  })

  it('shows the GitHub review helper text when a PR URL exists', () => {
    renderPanel()

    expect(screen.getByText(/Review the draft PR in GitHub if you want/i)).toBeTruthy()
  })

  it('does not render invalid PR URLs as external links', () => {
    renderPanel({
      runtime: {
        prUrl: 'https://evil.example/test/repo/pull/42',
      },
    } as Parameters<typeof makeTicket>[0])

    expect(screen.queryByRole('link', { name: /open/i })).toBeNull()
    expect(screen.getByText('Invalid PR URL')).toBeTruthy()
    expect(screen.queryByText(/Review the draft PR in GitHub if you want/i)).toBeNull()
  })
})
