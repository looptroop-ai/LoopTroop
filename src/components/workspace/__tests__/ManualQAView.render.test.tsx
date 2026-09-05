import { useEffect, useState } from 'react'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { makeTicket } from '@/test/factories'
import type { ManualQaRound } from '@/hooks/useManualQA'

const mocks = vi.hoisted(() => ({
  index: vi.fn(),
  round: vi.fn(),
  uiState: vi.fn(),
  save: vi.fn(),
  refetchUiState: vi.fn(),
  submit: vi.fn(),
  skip: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  refetchRound: vi.fn(),
  includeDrift: vi.fn(),
  discardDrift: vi.fn(),
  logSection: vi.fn((_props: Record<string, unknown>) => <div data-testid="manual-qa-log" />),
  artifacts: vi.fn(() => ({ artifacts: [], status: 'success', isLoading: false, isFetching: false, isError: false, error: null, refetch: vi.fn() })),
}))

vi.mock('@/hooks/useTicketArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTicketArtifacts')>()
  return { ...actual, useTicketArtifacts: mocks.artifacts }
})

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: [{ id: 1, manualQaOverride: true }] }),
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { manualQaEnabled: false } }),
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: mocks.logSection,
}))

vi.mock('@/hooks/useTickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTickets')>()
  return {
    ...actual,
    useTicketUIState: mocks.uiState,
    useSaveTicketUIState: () => ({ mutateAsync: mocks.save }),
  }
})

vi.mock('@/hooks/useManualQA', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useManualQA')>()
  const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutate: fn, mutateAsync: fn, isPending: false })
  return {
    ...actual,
    useManualQaIndex: mocks.index,
    useManualQaRound: mocks.round,
    useSubmitManualQa: () => mutation(mocks.submit),
    useSkipManualQa: () => mutation(mocks.skip),
    useResolveManualQaDrift: (decision: 'include' | 'discard') => mutation(decision === 'include' ? mocks.includeDrift : mocks.discardDrift),
    useUploadManualQaEvidence: () => mutation(mocks.upload),
    useRemoveManualQaEvidence: () => mutation(mocks.remove),
  }
})

import { ManualQAView } from '../ManualQAView'

const round: ManualQaRound = {
  version: 1,
  status: 'waiting',
  checklistHash: 'a'.repeat(64),
  checklist: {
    schemaVersion: 1,
    version: 1,
    items: [{
      id: 'item-1',
      lineageId: 'checkout',
      title: 'Submit checkout',
      source: 'prd',
      behavior: 'A valid checkout can be submitted.',
      severity: 'required',
      prerequisites: [],
      actions: ['Press submit.'],
      expectedResult: 'The order is confirmed.',
      prdRefs: [],
    }],
  },
  coverage: [],
  coverageSummary: { coveredCount: 0, partiallyCoveredCount: 0, uncoveredCount: 0, notApplicableCount: 0, sourceItemCounts: { prd: 0, bead: 0, previousQa: 0, implementationDiff: 0 } },
  evidence: [],
  draftRevision: 0,
}

function checklistItem(id: string, title: string, severity: 'required' | 'optional' = 'optional') {
  return {
    ...round.checklist!.items[0]!,
    id,
    lineageId: id,
    title,
    severity,
  }
}

function evidenceFile(index: number) {
  return {
    id: `evidence-${index}`,
    itemId: 'item-1',
    name: `evidence-${index}.png`,
    size: index * 10,
    sha256: String(index).repeat(64).slice(0, 64),
    mediaType: 'image/png',
    previewable: true,
  }
}

function waitingTicket() {
  return makeTicket({
    status: 'WAITING_MANUAL_QA',
    manualQa: {
      activeVersion: 1,
      completedRoundCount: 0,
      latestOutcome: null,
      artifactAvailability: { checklist: true, results: false, coverage: true, summary: false },
    },
  })
}

describe('ManualQAView recovery behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.index.mockReturnValue({
      data: { activeVersion: 1, completedRounds: 0, latestOutcome: null, artifactAvailable: true, versions: [{ version: 1, status: 'waiting', artifactAvailable: true, phaseAttempt: 1 }] },
      isLoading: false,
      error: null,
    })
    mocks.uiState.mockReturnValue({
      data: { scope: 'manual_qa_draft:v1', exists: false, data: null, revision: 0, clientRevision: null, updatedAt: null },
      refetch: mocks.refetchUiState,
    })
    mocks.refetchRound.mockResolvedValue({ data: round })
    mocks.round.mockReturnValue({ data: round, isLoading: false, error: null, refetch: mocks.refetchRound })
    mocks.save.mockResolvedValue({ conflict: false, revision: 1, updatedAt: new Date().toISOString() })
    mocks.refetchUiState.mockResolvedValue({ data: { data: { results: {} }, revision: 2 } })
    mocks.submit.mockResolvedValue({})
    mocks.skip.mockResolvedValue({})
    mocks.remove.mockResolvedValue({ success: true })
    mocks.includeDrift.mockResolvedValue({ success: true })
    mocks.discardDrift.mockResolvedValue({ success: true })
  })

  afterEach(() => cleanup())

  it('defaults required checks to Pending first without showing result-specific fields', () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    const pending = screen.getByRole('button', { name: 'Pending' })
    const pass = screen.getByRole('button', { name: 'Pass' })
    expect(pending).toHaveAttribute('data-selected', 'true')
    expect(pending.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/select pass if.*fail if.*waive/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Evidence' })).not.toBeInTheDocument()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('restores a saved draft that arrives after the round', async () => {
    // Switching tickets remounts this view, so the round can be served from cache while the saved
    // draft is still on the wire. The load-bearing assertion is the final one: Pass is the saved
    // status, and it can only appear if the draft-init effect waited for the query instead of
    // locking itself to the round's own (empty) draft on the first render.
    const savedState = {
      scope: 'manual_qa_draft:v1',
      exists: true,
      data: { results: { 'item-1': { itemId: 'item-1', status: 'pass', evidenceIds: [] } } },
      revision: 3,
      clientRevision: null,
      updatedAt: new Date().toISOString(),
    }
    mocks.uiState.mockImplementation(() => {
      // A hook, not a value: the first render reports the query as pending and a re-render delivers
      // the saved draft, which is the ordering the real query produces on a cached round.
      const [settled, setSettled] = useState(false)
      useEffect(() => setSettled(true), [])
      return settled
        ? { data: savedState, isPending: false, refetch: mocks.refetchUiState }
        : { data: undefined, isPending: true, refetch: mocks.refetchUiState }
    })

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pass' })).toHaveAttribute('data-selected', 'true'))
    expect(screen.getByRole('button', { name: 'Pending' })).toHaveAttribute('data-selected', 'false')
  })

  it('names the checklist number and title in submission validation', async () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Item 1 Submit checkout: Required checks must be marked Pass, Fail, Waive, or Improvement.',
    )
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('edits an Improvement inline with secondary context and previews collapsed', () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Improvement' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Improvement' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/^Title/).parentElement?.querySelector('input')).toBeInTheDocument()
    expect(screen.getByText(/^Description/).parentElement?.querySelector('textarea')).toBeInTheDocument()
    for (const name of ['Advanced', 'Manual QA context', 'Final description preview', 'Evidence and provenance preview']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false')
    }
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('3')
    fireEvent.click(screen.getByRole('button', { name: 'Manual QA context' }))
    const contextEditor = screen.getByRole('button', { name: 'Manual QA context' }).parentElement?.parentElement?.querySelector('textarea')
    expect(contextEditor?.value).toContain('## Manual QA Context')
    expect(screen.queryByText(/required check.*incomplete/i)).not.toBeInTheDocument()
  })

  it('submits the selected improvement priority and explicit Manual QA setting', async () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Improvement' }))
    const title = screen.getByText(/^Title/).parentElement!.querySelector('input')!
    const description = screen.getByText(/^Description/).parentElement!.querySelector('textarea')!
    fireEvent.change(title, { target: { value: 'Improve checkout feedback' } })
    fireEvent.change(description, { target: { value: 'Make the confirmation state clearer.' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    expect(mocks.submit.mock.calls[0]![0].draft.improvements[0]).toMatchObject({
      priority: 2,
      manualQaEnabled: false,
    })
  })

  it('keeps PRD coverage collapsed by default', () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        coverage: [{ criterionRef: 'EP-1/ST-1/AC-1', criterion: 'Checkout succeeds', status: 'covered', itemIds: ['item-1'] }],
        coverageSummary: { ...round.coverageSummary, coveredCount: 1, sourceItemCounts: { ...round.coverageSummary.sourceItemCounts, prd: 1 } },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    const coverage = screen.getByRole('button', { name: /PRD coverage/i })
    expect(coverage).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Checkout succeeds')).not.toBeInTheDocument()
    fireEvent.click(coverage)
    expect(screen.getByText('Checkout succeeds')).toBeInTheDocument()
  })

  it('shows PRD criteria that are not applicable to Manual QA with their reason', () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        coverage: [{ criterionRef: 'EP-1/ST-2/AC-4', criterion: 'Build metadata is generated', status: 'not_applicable', itemIds: [], reason: 'Verified by the build pipeline.' }],
        coverageSummary: { ...round.coverageSummary, notApplicableCount: 1 },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: /PRD coverage/i }))
    expect(screen.getByText('Not applicable to Manual QA')).toBeInTheDocument()
    expect(screen.getByText(/Verified by the build pipeline/)).toBeInTheDocument()
    expect(screen.getByText('1 not applicable')).toBeInTheDocument()
  })

  it('binds a collapsed Manual QA log to the selected round phase attempt', () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(mocks.logSection).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'WAITING_MANUAL_QA',
      phaseAttempt: 1,
      logMode: 'live',
      defaultExpanded: false,
    }), undefined)
  })

  it('automatically expands the Manual QA log when submission is in progress with failures', () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        draft: { results: { 'item-1': { itemId: 'item-1', status: 'fail', observation: 'Failed result.' } } },
        operation: { actionId: 'manual-qa-submit:resume-1', state: 'creating_beads', status: 'creating_beads', operationType: 'submit' },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(mocks.logSection).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'WAITING_MANUAL_QA',
      phaseAttempt: 1,
      logMode: 'live',
      defaultExpanded: true,
    }), undefined)
  })

  it('blocks submission after an autosave conflict and offers an explicit reload', async () => {
    mocks.save.mockResolvedValueOnce({ conflict: true, revision: 2, data: { results: {} } })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))

    expect(await screen.findByText(/newer draft.*reload/i)).toBeInTheDocument()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /reload latest draft/i })).toBeInTheDocument()
  })

  it('reuses the server journal action ID when resuming a partial submission', async () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        draft: { results: { 'item-1': { itemId: 'item-1', status: 'pass' } } },
        operation: { actionId: 'manual-qa-submit:resume-1', state: 'creating_beads', status: 'creating_beads' },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip Manual QA…' })).toBeDisabled()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume submission' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    expect(mocks.submit.mock.calls[0]![0].actionId).toBe('manual-qa-submit:resume-1')
    expect(screen.getByText(/Submission operation: creating beads.*Editing and Skip are locked/i)).toBeInTheDocument()
  })

  it('resumes a partial skip with its journal action instead of starting submit', async () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        draft: { results: { 'item-1': { itemId: 'item-1', status: 'pending' } }, skipReason: 'Already checked.' },
        operation: { actionId: 'manual-qa-skip:resume-1', operationType: 'skip', state: 'staged', status: 'staged' },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume skip' }))

    await waitFor(() => expect(mocks.skip).toHaveBeenCalled())
    expect(mocks.skip.mock.calls[0]![0].actionId).toBe('manual-qa-skip:resume-1')
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('keeps each successful file linked when a later upload fails', async () => {
    mocks.upload
      .mockResolvedValueOnce({ ...evidenceFile(1), name: 'first.png' })
      .mockRejectedValueOnce(new Error('too large'))
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const first = new File(['first'], 'first.png', { type: 'image/png' })
    const second = new File(['second'], 'second.bin', { type: 'application/octet-stream' })
    fireEvent.change(input, { target: { files: [first, second] } })

    expect(await screen.findByText('first.png')).toBeInTheDocument()
    expect(await screen.findByText(/confirmed uploads remain linked/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    expect(mocks.submit.mock.calls[0]![0].draft.results[0].evidenceIds).toEqual(['evidence-1'])
  })

  it('shows matching Add link and Add files actions and reveals Link and Details only on request', () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))

    const addLink = screen.getByRole('button', { name: 'Add link' })
    const addFiles = screen.getByRole('button', { name: 'Add files' })
    expect(addLink.compareDocumentPosition(addFiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByLabelText(/Evidence link for item-1/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Evidence link details for item-1/i)).not.toBeInTheDocument()

    fireEvent.click(addLink)
    expect(screen.getByLabelText(/Evidence link for item-1/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Evidence link details for item-1/i)).toBeInTheDocument()
    expect(screen.queryByText(/label \(optional\)/i)).not.toBeInTheDocument()
  })

  it('opens the native file picker from a real button without starting an upload or unmounting Manual QA', () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    const input = screen.getByLabelText('Choose evidence files for item-1') as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: 'Add files' }))

    expect(inputClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'Manual QA' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit QA' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add files' })).toBeInTheDocument()
    expect(input).toBeInTheDocument()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('renders a successful upload immediately without requiring a refresh', async () => {
    mocks.upload.mockResolvedValue({ ...evidenceFile(1), name: 'receipt.png' })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['image'], 'receipt.png', { type: 'image/png' })] } })

    expect(await screen.findByText('receipt.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove receipt.png' })).toBeInTheDocument()
    expect(mocks.refetchRound).not.toHaveBeenCalled()
  })

  it('shows five evidence files initially and expands and collapses the remainder', () => {
    const files = Array.from({ length: 7 }, (_, index) => evidenceFile(index + 1))
    mocks.round.mockReturnValue({ data: { ...round, evidence: files }, isLoading: false, error: null, refetch: mocks.refetchRound })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))

    for (const file of files.slice(0, 5)) expect(screen.getByText(file.name)).toBeInTheDocument()
    expect(screen.queryByText(files[5]!.name)).not.toBeInTheDocument()
    expect(screen.queryByText(files[6]!.name)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show .*more/i }))
    expect(screen.getByText(files[5]!.name)).toBeInTheDocument()
    expect(screen.getByText(files[6]!.name)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show less/i }))
    expect(screen.queryByText(files[5]!.name)).not.toBeInTheDocument()
  })

  it('reuses upload identities with refreshed CAS guards from the explicit retry state', async () => {
    mocks.upload.mockRejectedValue(new Error('connection lost'))
    mocks.refetchRound.mockResolvedValue({ data: { ...round, draftRevision: 7 } })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['same'], 'same.bin', { type: 'application/octet-stream', lastModified: 123 })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry upload' }))
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2))

    expect(mocks.upload.mock.calls[1]![0].actionId).toBe(mocks.upload.mock.calls[0]![0].actionId)
    expect(mocks.upload.mock.calls[1]![0].evidenceId).toBe(mocks.upload.mock.calls[0]![0].evidenceId)
    expect(mocks.upload.mock.calls[0]![0].expectedDraftRevision).toBe(0)
    expect(mocks.upload.mock.calls[1]![0].expectedDraftRevision).toBe(7)
  })

  it('assigns distinct identities to selected files with identical browser metadata', async () => {
    mocks.upload.mockRejectedValue(new Error('connection lost'))
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const first = new File(['aaaa'], 'same.bin', { type: 'application/octet-stream', lastModified: 123 })
    const second = new File(['bbbb'], 'same.bin', { type: 'application/octet-stream', lastModified: 123 })
    fireEvent.change(input, { target: { files: [first, second] } })
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2))

    expect(mocks.upload.mock.calls[1]![0].actionId).not.toBe(mocks.upload.mock.calls[0]![0].actionId)
    expect(mocks.upload.mock.calls[1]![0].evidenceId).not.toBe(mocks.upload.mock.calls[0]![0].evidenceId)
    expect(screen.getAllByRole('button', { name: 'Retry upload' })).toHaveLength(2)
  })

  it('shows removal failures and retries with the same action identity', async () => {
    const evidenceRound = { ...round, evidence: [{ id: 'evidence-1', itemId: 'item-1', name: 'screen.png', size: 10, sha256: 'a'.repeat(64), mediaType: 'image/png', previewable: true }] }
    mocks.round.mockReturnValue({ data: evidenceRound, isLoading: false, error: null, refetch: mocks.refetchRound })
    mocks.refetchRound.mockResolvedValue({ data: { ...evidenceRound, draftRevision: 8 } })
    mocks.remove.mockRejectedValue(new Error('connection lost'))
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove screen.png' }))
    expect(await screen.findByText(/same action identity with the latest draft revision/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove screen.png' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2))

    expect(mocks.remove.mock.calls[1]![0].actionId).toBe(mocks.remove.mock.calls[0]![0].actionId)
    expect(mocks.remove.mock.calls[0]![0].expectedDraftRevision).toBe(0)
    expect(mocks.remove.mock.calls[1]![0].expectedDraftRevision).toBe(8)
  })

  it('blocks completion while evidence removal settles and submits without the removed reference', async () => {
    const evidenceRound = {
      ...round,
      evidence: [{ id: 'evidence-1', itemId: 'item-1', name: 'screen.png', size: 10, sha256: 'a'.repeat(64), mediaType: 'image/png', previewable: true }],
    }
    mocks.round.mockReturnValue({ data: evidenceRound, isLoading: false, error: null, refetch: mocks.refetchRound })
    mocks.uiState.mockReturnValue({
      data: {
        scope: 'manual_qa_draft:v1',
        exists: true,
        data: { results: { 'item-1': { itemId: 'item-1', status: 'pass', evidenceIds: ['evidence-1'] } } },
        revision: 1,
        clientRevision: null,
        updatedAt: new Date().toISOString(),
      },
      refetch: mocks.refetchUiState,
    })
    let resolveRemoval!: (value: { success: boolean }) => void
    mocks.remove.mockImplementationOnce(() => new Promise((resolve) => { resolveRemoval = resolve }))
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove screen.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Waive' }))

    expect(screen.getByRole('button', { name: 'Submit QA' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip Manual QA…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))
    expect(mocks.submit).not.toHaveBeenCalled()

    resolveRemoval({ success: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit QA' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    expect(mocks.submit.mock.calls[0]![0].draft.results[0]).toMatchObject({
      outcome: 'waive',
      evidenceIds: [],
    })
  })

  it('allows an empty optional waiver reason and submits it', async () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Waive' }))

    const reason = screen.getByText(/Waiver reason/i).parentElement?.querySelector('textarea')
    expect(reason).toBeInTheDocument()
    expect(reason!.parentElement).toHaveTextContent(/optional/i)
    expect(reason!.parentElement).not.toHaveTextContent('*')
    expect(screen.queryByText(/explain why this check is being waived/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit QA' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    expect(mocks.submit.mock.calls[0]![0].draft.results[0]).toMatchObject({ outcome: 'waive' })
  })

  it('selects multiple numbered merge items and blocks submit until every selected item fails', async () => {
    const items = [
      checklistItem('item-1', 'Submit checkout', 'required'),
      checklistItem('item-2', 'Calculate shipping'),
      checklistItem('item-3', 'Send confirmation'),
    ]
    mocks.round.mockReturnValue({
      data: { ...round, checklist: { ...round.checklist!, items } },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    const firstCard = screen.getByText('1. Submit checkout').closest('[class*="rounded-xl"]') ?? screen.getByText('1. Submit checkout').parentElement!.parentElement!.parentElement
    fireEvent.click(within(firstCard as HTMLElement).getByRole('button', { name: 'Fail' }))
    fireEvent.change(within(firstCard as HTMLElement).getByPlaceholderText(/What happened/i), { target: { value: 'Checkout remained open.' } })

    const shipping = within(firstCard as HTMLElement).getByRole('button', { name: '2. Calculate shipping' })
    const confirmation = within(firstCard as HTMLElement).getByRole('button', { name: '3. Send confirmation' })
    fireEvent.click(shipping)
    fireEvent.click(confirmation)
    expect(shipping).toHaveAttribute('data-selected', 'true')
    expect(confirmation).toHaveAttribute('data-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Item 1 Submit checkout has item 2 Calculate shipping and item 3 Send confirmation in its merge group, but those items were not marked as Fail.')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('shows autosave status beside completion and has no manual Save action', () => {
    const savedAt = new Date(Date.now() - 20_000)
    mocks.uiState.mockReturnValue({
      data: { scope: 'manual_qa_draft:v1', exists: true, data: { results: {} }, revision: 1, clientRevision: null, updatedAt: savedAt.toISOString() },
      refetch: mocks.refetchUiState,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByText(/1 required check incomplete/i).parentElement).toHaveTextContent(/Autosave on/i)
    const lastSave = screen.getByText(/last save.*20 seconds ago/i)
    expect(lastSave).toHaveAttribute('title', savedAt.toLocaleString())
    expect(screen.queryByRole('button', { name: /Save now/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit QA' })).toBeInTheDocument()
  })

  it('archives entered invalid result data when Skip Manual QA is confirmed', async () => {
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fail' }))

    fireEvent.click(screen.getByRole('button', { name: 'Skip Manual QA…' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/no.*bead.*or.*improvement.*will be created/i)
    expect(dialog).toHaveTextContent(/entered results.*will be saved.*cannot be edited/i)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip and integrate' }))

    await waitFor(() => expect(mocks.skip).toHaveBeenCalled())
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ results: expect.objectContaining({ 'item-1': expect.objectContaining({ status: 'fail' }) }) }),
    }))
    expect(mocks.skip.mock.calls[0]![0].draft.results[0]).toMatchObject({ outcome: 'fail' })
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('shows drift failures and retries the decision with the same action identity', async () => {
    const driftRound = { ...round, workspaceDrift: { detected: true, decisionRequired: true, files: [{ path: 'runtime.log' }] } }
    mocks.round.mockReturnValue({ data: driftRound, isLoading: false, error: null, refetch: mocks.refetchRound })
    mocks.refetchRound.mockResolvedValue({ data: { ...driftRound, draftRevision: 9 } })
    mocks.includeDrift.mockRejectedValue(new Error('connection lost'))
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Include in checkpoint' }))
    expect(await screen.findByText(/choose the same action to retry safely/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Include in checkpoint' }))
    await waitFor(() => expect(mocks.includeDrift).toHaveBeenCalledTimes(2))

    expect(mocks.includeDrift.mock.calls[1]![0].actionId).toBe(mocks.includeDrift.mock.calls[0]![0].actionId)
    expect(mocks.includeDrift.mock.calls[0]![0].expectedDraftRevision).toBe(0)
    expect(mocks.includeDrift.mock.calls[1]![0].expectedDraftRevision).toBe(9)
  })

  it('renders complete historical summary and coverage provenance', () => {
    mocks.round.mockReturnValue({
      data: {
        ...round,
        readOnly: true,
        outcome: 'waived_through',
        coverage: [{ criterionRef: 'EP-1/ST-1/AC-1', criterion: 'Checkout succeeds', status: 'covered', itemIds: ['item-1'] }],
        coverageSummary: { coveredCount: 1, partiallyCoveredCount: 0, uncoveredCount: 0, notApplicableCount: 0, sourceItemCounts: { prd: 1, bead: 2, previousQa: 0, implementationDiff: 3 } },
        summary: {
          outcome: 'waived_through', createdFixBeadIds: ['QA-v1-1'], improvementTicketIds: ['APP-9'], waivedItemIds: ['item-1'], waivedItems: [{ itemId: 'item-1', reason: 'Unavailable device' }], durationMs: 65_000,
          itemCounts: { pass: 0, fail: 0, waive: 1, improvement: 0, pending: 0 }, requiredItemCount: 1, optionalItemCount: 0, evidenceCount: 2, nextAction: 'integrate', coverage: { covered: 1, partiallyCovered: 0, uncovered: 0, notApplicable: 0 }, modelCapability: null,
        },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} readOnly />)

    expect(screen.getByText('Round summary')).toBeInTheDocument()
    expect(screen.getByText(/1m 5s/)).toBeInTheDocument()
    expect(screen.getByText(/QA-v1-1/)).toBeInTheDocument()
    expect(screen.getByText(/APP-9/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /PRD coverage/i }))
    expect(screen.getByText('Checkout succeeds')).toBeInTheDocument()
    expect(screen.getByText('implementation diff: 3')).toBeInTheDocument()
  })

  it('renders checklist source counts when there are no PRD criteria', () => {
    mocks.round.mockReturnValue({
      data: { ...round, coverageSummary: { ...round.coverageSummary, sourceItemCounts: { ...round.coverageSummary.sourceItemCounts, implementationDiff: 2 } } },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    })
    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    const coverage = screen.getByRole('button', { name: /PRD coverage/i })
    expect(coverage).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(coverage)
    expect(screen.getByText('implementation diff: 2')).toBeInTheDocument()
  })

  it('opens the newest artifact-backed round while the next checklist generates', () => {
    const ticket = makeTicket({
      status: 'GENERATING_QA_CHECKLIST',
      manualQa: {
        activeVersion: 2,
        completedRoundCount: 1,
        latestOutcome: 'created_fixes',
        artifactAvailability: { checklist: true, results: true, coverage: true, summary: true },
      },
    })
    mocks.index.mockReturnValue({
      data: {
        activeVersion: 2,
        completedRounds: 1,
        latestOutcome: 'created_fixes',
        artifactAvailable: true,
        versions: [
          { version: 1, status: 'completed', outcome: 'created_fixes', artifactAvailable: true, phaseAttempt: 1 },
          { version: 2, status: 'generating', artifactAvailable: false, phaseAttempt: 2 },
        ],
      },
      isLoading: false,
      error: null,
    })
    mocks.round.mockImplementation((_ticketId: string, version: number) => ({
      data: version === 1 ? { ...round, readOnly: true, outcome: 'created_fixes' } : undefined,
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    }))

    renderWithProviders(<ManualQAView ticket={ticket} />)

    expect(screen.getByRole('heading', { name: 'Manual QA' })).toBeInTheDocument()
    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(mocks.round).toHaveBeenLastCalledWith(ticket.id, 1, true)
    expect(screen.queryByLabelText('Manual QA version')).not.toBeInTheDocument()
  })

  it('defaults to the newest artifact-backed round instead of a reserved active version', () => {
    const ticket = makeTicket({
      status: 'CODING',
      manualQa: {
        activeVersion: 2,
        completedRoundCount: 1,
        latestOutcome: 'created_fixes',
        artifactAvailability: { checklist: true, results: true, coverage: true, summary: true },
      },
    })
    mocks.index.mockReturnValue({
      data: {
        activeVersion: 2,
        completedRounds: 1,
        latestOutcome: 'created_fixes',
        artifactAvailable: true,
        versions: [
          { version: 1, status: 'completed', outcome: 'created_fixes', artifactAvailable: true, phaseAttempt: 3 },
          { version: 2, status: 'generating', artifactAvailable: false, phaseAttempt: 4 },
        ],
      },
      isLoading: false,
      error: null,
    })
    mocks.round.mockImplementation((_ticketId: string, selectedVersion: number) => ({
      data: selectedVersion === 1 ? { ...round, readOnly: true, outcome: 'created_fixes' } : undefined,
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    }))

    renderWithProviders(<ManualQAView ticket={ticket} readOnly />)

    expect(mocks.round).toHaveBeenLastCalledWith(ticket.id, 1, true)
    expect(screen.getByRole('heading', { name: 'Manual QA' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Manual QA version')).not.toBeInTheDocument()
    expect(mocks.logSection.mock.calls.at(-1)?.[0]).toMatchObject({ phaseAttempt: 3, logMode: 'snapshot' })
  })

  it('shows the version selector only for multiple artifact-backed rounds and switches log snapshots with it', () => {
    mocks.index.mockReturnValue({
      data: {
        activeVersion: 2,
        completedRounds: 1,
        latestOutcome: 'passed',
        artifactAvailable: true,
        versions: [
          { version: 1, status: 'completed', outcome: 'created_fixes', artifactAvailable: true, phaseAttempt: 5 },
          { version: 2, status: 'waiting', artifactAvailable: true, phaseAttempt: 6 },
        ],
      },
      isLoading: false,
      error: null,
    })
    mocks.round.mockImplementation((_ticketId: string, selectedVersion: number) => ({
      data: { ...round, version: selectedVersion, checklist: { ...round.checklist!, version: selectedVersion }, readOnly: selectedVersion === 1 },
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    }))
    const ticket = makeTicket({
      status: 'WAITING_MANUAL_QA',
      manualQa: {
        activeVersion: 2,
        completedRoundCount: 1,
        latestOutcome: 'created_fixes',
        artifactAvailability: { checklist: true, results: false, coverage: true, summary: false },
      },
    })
    renderWithProviders(<ManualQAView ticket={ticket} />)

    const selector = screen.getByLabelText('Manual QA version')
    expect(selector).toHaveValue('2')
    fireEvent.change(selector, { target: { value: '1' } })

    expect(screen.getByRole('heading', { name: 'Manual QA' })).toBeInTheDocument()
    expect(mocks.logSection.mock.calls.at(-1)?.[0]).toMatchObject({ phaseAttempt: 5, logMode: 'snapshot' })
  })

  it('does not query a reserved active version until generation hands it to Manual QA', () => {
    const generatingTicket = makeTicket({
      status: 'GENERATING_QA_CHECKLIST',
      manualQa: {
        activeVersion: 1,
        completedRoundCount: 0,
        latestOutcome: null,
        artifactAvailability: { checklist: false, results: false, coverage: false, summary: false },
      },
    })
    mocks.round.mockImplementation((_ticketId: string, _version: number, enabled: boolean) => ({
      data: enabled ? round : undefined,
      isLoading: false,
      error: null,
      refetch: mocks.refetchRound,
    }))
    mocks.index.mockReturnValue({
      data: {
        activeVersion: 1,
        completedRounds: 0,
        latestOutcome: null,
        artifactAvailable: false,
        versions: [{ version: 1, status: 'generating', artifactAvailable: false, phaseAttempt: 1 }],
      },
      isLoading: false,
      error: null,
    })

    const { rerender } = renderWithProviders(<ManualQAView ticket={generatingTicket} />)
    expect(mocks.round).toHaveBeenLastCalledWith(generatingTicket.id, null, false)

    mocks.index.mockReturnValue({
      data: { activeVersion: 1, completedRounds: 0, latestOutcome: null, artifactAvailable: true, versions: [{ version: 1, status: 'waiting', artifactAvailable: true, phaseAttempt: 1 }] },
      isLoading: false,
      error: null,
    })
    rerender(<ManualQAView ticket={waitingTicket()} />)
    expect(mocks.round).toHaveBeenLastCalledWith(generatingTicket.id, 1, true)
    expect(screen.getByRole('heading', { name: 'Manual QA' })).toBeInTheDocument()
    expect(screen.queryByText('Manual QA version not found')).not.toBeInTheDocument()
  })

  it('tells the person running the checks that the checklist was repaired', () => {
    // The companion belongs to the generating phase, whose artifact chip is not
    // where anyone stands while doing Manual QA. Showing it only there meant an
    // operator worked through a repaired checklist believing it was a clean
    // first pass.
    mocks.artifacts.mockReturnValue({
      artifacts: [{
        id: 1,
        phase: 'GENERATING_QA_CHECKLIST',
        phaseAttempt: 1,
        artifactType: 'ui_artifact_companion:manual_qa_checklist',
        content: JSON.stringify({
          baseArtifactType: 'manual_qa_checklist',
          generatedAt: '2026-07-14T10:00:00.000Z',
          payload: {
            structuredOutput: {
              repairApplied: true,
              repairWarnings: [],
              autoRetryCount: 1,
              validationError: 'Manual QA parser rejected the model output.',
            },
          },
        }),
        filePath: null,
        createdAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:00:00.000Z',
      }],
      status: 'success',
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mocks.artifacts>)

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByText(/LoopTroop adjusted this artifact/i)).toBeInTheDocument()
  })

  it('shows the repair trail when generation produced no checklist at all', () => {
    // The run that used up its retries writes the companion and no checklist,
    // so the view takes its "not available yet" branch — which is exactly the
    // run whose failed attempts the operator's next move depends on.
    mocks.round.mockReturnValue({ data: undefined, isLoading: false, error: null, refetch: mocks.refetchRound })
    mocks.artifacts.mockReturnValue({
      artifacts: [{
        id: 1,
        phase: 'GENERATING_QA_CHECKLIST',
        phaseAttempt: 1,
        artifactType: 'ui_artifact_companion:manual_qa_checklist',
        content: JSON.stringify({
          baseArtifactType: 'manual_qa_checklist',
          generatedAt: '2026-07-14T10:00:00.000Z',
          // Both fields, as the give-up path writes them: the top-level one is
          // what says the generation itself failed, rather than an attempt
          // within a generation that went on to succeed.
          payload: {
            validationError: 'Manual QA checklist generation failed.',
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 2,
              validationError: 'Manual QA checklist generation failed.',
            },
          },
        }),
        filePath: null,
        createdAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:00:00.000Z',
      }],
      status: 'success',
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mocks.artifacts>)

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByText(/Manual QA artifacts are not available yet/i)).toBeInTheDocument()
    // "Intervention details", not "LoopTroop adjusted" — the companion carries
    // a validationError, and describing a generation that gave up as completed
    // is what this screen and the artifact chip used to disagree about.
    expect(screen.getByText(/Intervention details for this artifact/i)).toBeInTheDocument()
  })

  it('does not describe a failed generation as a completed one', () => {
    // Same companion, but a checklist exists — a repair that succeeded on a
    // later attempt. This is the success tree, which omitted the status
    // entirely and so defaulted every generation to "completed".
    mocks.artifacts.mockReturnValue({
      artifacts: [{
        id: 1,
        phase: 'GENERATING_QA_CHECKLIST',
        phaseAttempt: 1,
        artifactType: 'ui_artifact_companion:manual_qa_checklist',
        content: JSON.stringify({
          baseArtifactType: 'manual_qa_checklist',
          generatedAt: '2026-07-14T10:00:00.000Z',
          payload: {
            validationError: 'Manual QA checklist generation failed.',
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 2,
              validationError: 'Manual QA checklist generation failed.',
            },
          },
        }),
        filePath: null,
        createdAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:00:00.000Z',
      }],
      status: 'success',
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mocks.artifacts>)

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.getByText(/Intervention details for this artifact/i)).toBeInTheDocument()
    expect(screen.queryByText(/LoopTroop adjusted this artifact/i)).not.toBeInTheDocument()
  })

  it('says nothing when the checklist generated first time', () => {
    mocks.artifacts.mockReturnValue({
      artifacts: [], status: 'success', isLoading: false, isFetching: false, isError: false, error: null, refetch: vi.fn(),
    } as unknown as ReturnType<typeof mocks.artifacts>)

    renderWithProviders(<ManualQAView ticket={waitingTicket()} />)

    expect(screen.queryByText(/LoopTroop adjusted this artifact/i)).not.toBeInTheDocument()
  })
})
