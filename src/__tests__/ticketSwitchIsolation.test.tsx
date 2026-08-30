/**
 * Cross-ticket state isolation.
 *
 * `App` keys the dashboard subtree by ticket id, so opening a different ticket unmounts the
 * previous ticket's workspace instead of re-rendering it with new props. These tests are the
 * regression guard for that key: they drive the real `App`, the real `TicketDashboard` and the
 * real workspace views, put something into a surface on one ticket, switch, and assert the
 * surface on the second ticket is empty.
 *
 * Two things about the shape of this file are deliberate:
 *
 * - One test per workspace surface rather than one test overall. The workspace is routed by
 *   status, so a surface only exists for the status that renders it. Both tickets in a test
 *   therefore share a status, which is the only situation where that surface can leak at all.
 * - Every assertion anchors on state that nothing else resets. Most surfaces also have a restore
 *   effect that assigns unconditionally once the new ticket's query resolves, so a leaked draft
 *   would be overwritten a tick later and the assertion would pass whether or not the subtree was
 *   remounted. Open dialogs, skip forms, edit buffers, selected versions and error overlays have
 *   no such effect: only the remount clears them, so only they can fail when the key is removed.
 *
 * Tickets are switched by dispatching `SELECT_TICKET`, which is what the board and the navigator
 * do, and which works while a modal dialog holds the focus trap.
 *
 * Only the chrome and the pieces jsdom cannot run are stubbed: there is no `EventSource` in jsdom
 * so `useSSE` is mocked, and the header, navigator and board are replaced by markers.
 */
import type { ReactNode, Ref } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterviewSessionView, PersistedInterviewBatch } from '@shared/interviewSession'
import { queryClient } from '@/lib/queryClient'
import { UIProvider } from '@/context/UIContext'
import { useUI } from '@/context/useUI'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WELCOME_DISCLAIMER_STORAGE_KEY } from '@/components/shared/WelcomeDisclaimer'
import { makeTicket, TEST } from '@/test/factories'
import { createJsonResponse } from '@/test/renderHelpers'
import type { Ticket } from '@/hooks/useTickets'
import type { ManualQaIndex, ManualQaRound } from '@/hooks/useManualQA'

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))

vi.mock('@/components/kanban/KanbanBoard', () => ({
  KanbanBoard: () => <div>Kanban Board</div>,
}))

vi.mock('@/components/shared/KeyboardShortcuts', () => ({
  KeyboardShortcuts: () => null,
}))

vi.mock('@/components/shared/CenteredModal', () => ({
  CenteredModal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}))

vi.mock('@/hooks/useStartupStatus', () => ({
  useStartupStatus: () => ({ data: null }),
  useDismissStartupRestoreNotice: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/useRecoveryAutoReload', () => ({
  useRecoveryAutoReload: vi.fn(),
}))

vi.mock('@/hooks/useSSE', () => ({
  useSSE: () => ({ lastEventIdRef: { current: '0' }, connectionState: 'connected' as const }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, viewportRef, className }: {
    children: ReactNode
    viewportRef?: Ref<HTMLDivElement>
    className?: string
  }) => (
    <div className={className}>
      <div ref={viewportRef}>{children}</div>
    </div>
  ),
}))

vi.mock('@/components/ticket/DashboardHeader', () => ({
  DashboardHeader: ({ ticket }: { ticket: Ticket }) => <div data-testid="dashboard-header">{ticket.id}</div>,
}))

vi.mock('@/components/ticket/NavigatorPanel', () => ({
  NavigatorPanel: () => null,
}))

vi.mock('@/components/ticket/ResizeHandle', () => ({
  ResizeHandle: () => null,
}))

vi.mock('@/components/ticket/WorkspacePhaseSummary', () => ({
  WorkspacePhaseSummary: () => null,
}))

vi.mock('@/components/workspace/CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: () => null,
}))

import App from '@/App'

const TICKET_A_ID = TEST.ticketId
const TICKET_A_EXTERNAL = TEST.externalId
const TICKET_B_ID = `${TEST.projectId}:${TEST.shortnameB}-1`
const TICKET_B_EXTERNAL = `${TEST.shortnameB}-1`

const SKIP_REASON = 'These questions belong to the first ticket.'
const INTERVIEW_ANSWER = 'An answer typed for the first ticket.'
const DESCRIPTION_DRAFT = 'A description drafted for the first ticket.'
const QA_OBSERVATION = 'A failure observed on the first ticket.'
const QA_OBSERVATION_PLACEHOLDER = 'What happened, and how did it differ from the expected result?'
const RETRY_NOTE = 'A retry note written for the first ticket.'
const RETRY_NOTE_PLACEHOLDER = 'Add context, constraints, or a different approach for the next attempt...'
const START_FAILURE = 'The first ticket has no repository configured.'
const FIRST_QUESTION = 'Should the first ticket keep its retry budget?'
const SECOND_QUESTION = 'Should the second ticket keep its retry budget?'
const FIRST_ERROR_MESSAGE = 'The first ticket could not finish coding.'
const SECOND_ERROR_MESSAGE = 'The second ticket could not finish coding.'

interface TicketFixture {
  ticket: Ticket
  interview?: InterviewSessionView
  manualQaIndex?: ManualQaIndex
  manualQaRounds?: Record<number, ManualQaRound>
  questions?: Array<Record<string, unknown>>
}

const fixtures = new Map<string, TicketFixture>()
let failStart = false
let uiDispatch: ReturnType<typeof useUI>['dispatch'] | null = null

function CaptureUIDispatch() {
  uiDispatch = useUI().dispatch
  return null
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInterview(): InterviewSessionView {
  const batch: PersistedInterviewBatch = {
    questions: [{
      id: 'Q01',
      phase: 'Foundation',
      question: 'Which outcome matters most?',
      source: 'compiled',
    }],
    progress: { current: 1, total: 1 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'One question is still open.',
    batchNumber: 1,
    source: 'prom4',
  }

  return {
    winnerId: TEST.model,
    raw: null,
    session: {
      schemaVersion: 1,
      winnerId: TEST.model,
      maxInitialQuestions: 4,
      maxFollowUps: 2,
      questions: batch.questions,
      answers: {},
      currentBatch: batch,
      batchHistory: [],
      followUpRounds: [],
      rawFinalYaml: null,
      completedAt: null,
      updatedAt: TEST.timestamp,
    },
    questions: batch.questions.map((question) => ({ ...question, status: 'current' as const, answer: null })),
  }
}

function makeManualQaRound(version: number): ManualQaRound {
  return {
    version,
    status: 'waiting',
    // Identical on both tickets on purpose. The draft restore effect is keyed on
    // version plus checklist hash, so with matching fixtures it does not re-run on the second
    // ticket — which is exactly the case where only a remount can clear a leaked draft.
    checklistHash: 'a'.repeat(64),
    checklist: {
      schemaVersion: 1,
      version,
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
    coverageSummary: {
      coveredCount: 0,
      partiallyCoveredCount: 0,
      uncoveredCount: 0,
      notApplicableCount: 0,
      sourceItemCounts: { prd: 0, bead: 0, previousQa: 0, implementationDiff: 0 },
    },
    evidence: [],
    draftRevision: 0,
  }
}

function makeManualQaIndex(): ManualQaIndex {
  return {
    activeVersion: 2,
    completedRounds: 1,
    latestOutcome: null,
    artifactAvailable: true,
    versions: [
      { version: 1, status: 'waiting', artifactAvailable: true, phaseAttempt: 1 },
      { version: 2, status: 'waiting', artifactAvailable: true, phaseAttempt: 2 },
    ],
  }
}

function makePendingQuestion(ticketId: string, question: string): Record<string, unknown> {
  return {
    type: 'opencode_question',
    ticketId,
    // Distinct per ticket: the provider keys requests by session and request id, and never
    // overwrites a row it already holds.
    sessionId: `session-${ticketId}`,
    requestId: `request-${ticketId}`,
    questions: [{
      header: 'Confirm the approach',
      question,
      options: [],
    }],
  }
}

// ---------------------------------------------------------------------------
// Fetch router
// ---------------------------------------------------------------------------

function ticketIdFromUrl(url: string): string {
  const match = /\/api\/tickets\/([^/?]+)/.exec(url)
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

function routeFetch(url: string, method: string): Promise<Response> {
  const path = url.split('?')[0] ?? url
  const ticketId = ticketIdFromUrl(url)
  const fixture = fixtures.get(ticketId)

  if (path === '/api/opencode/questions') {
    return createJsonResponse({
      questions: [...fixtures.values()].flatMap((entry) => entry.questions ?? []),
      timers: {},
    })
  }
  if (path.endsWith('/opencode/questions')) {
    return createJsonResponse({ questions: fixture?.questions ?? [], timer: null })
  }
  if (path.includes('/opencode/question')) {
    return createJsonResponse({ success: true })
  }
  if (path === '/api/profile') return createJsonResponse(null)
  if (path === '/api/projects') return createJsonResponse([])
  if (path === '/api/tickets') {
    return createJsonResponse([...fixtures.values()].map((entry) => entry.ticket))
  }
  if (path.endsWith('/start')) {
    return failStart
      ? createJsonResponse({ error: START_FAILURE }, 409)
      : createJsonResponse({ success: true })
  }
  if (path.endsWith('/logs')) return createJsonResponse([])
  if (path.endsWith('/artifacts')) return createJsonResponse([])
  if (path.endsWith('/interview')) {
    return createJsonResponse(fixture?.interview ?? { winnerId: null, raw: null, session: null, questions: [] })
  }
  if (path.endsWith('/ui-state')) {
    if (method !== 'GET') {
      return createJsonResponse({ conflict: false, scope: '', updatedAt: null, revision: 1, clientRevision: null })
    }
    const scope = new URLSearchParams(url.split('?')[1] ?? '').get('scope') ?? ''
    return createJsonResponse({ scope, exists: false, data: null, updatedAt: null, revision: 0, clientRevision: null })
  }
  if (path.endsWith('/manual-qa')) return createJsonResponse(fixture?.manualQaIndex ?? null)

  const versionMatch = /\/manual-qa\/versions\/(\d+)$/.exec(path)
  if (versionMatch?.[1]) {
    return createJsonResponse(fixture?.manualQaRounds?.[Number(versionMatch[1])] ?? null)
  }
  if (fixture && path === `/api/tickets/${ticketId}`) {
    return createJsonResponse(fixture.ticket)
  }

  // Everything else answers empty rather than throwing. This file is about what the views keep
  // across a switch, and a surface that quietly renders nothing still proves nothing leaked.
  return createJsonResponse(method === 'GET' ? {} : { success: true })
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function seedTickets(...tickets: Ticket[]) {
  for (const ticket of tickets) {
    fixtures.set(ticket.id, { ...fixtures.get(ticket.id), ticket })
  }
  queryClient.setQueryData(['tickets'], tickets)
  for (const ticket of tickets) {
    queryClient.setQueryData(['ticket', ticket.id], ticket)
  }
  queryClient.setQueryData(['profile'], null)
  queryClient.setQueryData(['projects'], [])
}

function fixtureFor(ticket: Ticket): TicketFixture {
  const fixture = fixtures.get(ticket.id)
  if (!fixture) throw new Error(`No fixture seeded for ${ticket.id}`)
  return fixture
}

function renderApp() {
  return render(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <TooltipProvider>
          <CaptureUIDispatch />
          <App />
        </TooltipProvider>
      </UIProvider>
    </QueryClientProvider>,
  )
}

async function openTicket(ticket: Ticket) {
  act(() => {
    uiDispatch?.({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
  })
  await waitFor(() => {
    expect(screen.getByTestId('dashboard-header')).toHaveTextContent(ticket.id)
  })
  // The workspace views are lazy. Waiting for the Suspense fallback to go keeps the assertions
  // below from passing simply because the surface under test had not been mounted yet.
  await waitFor(() => {
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  }, { timeout: 5_000 })
}

beforeAll(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  })
})

beforeEach(() => {
  queryClient.clear()
  fixtures.clear()
  failStart = false
  uiDispatch = null
  localStorage.clear()
  localStorage.setItem(WELCOME_DISCLAIMER_STORAGE_KEY, 'true')
  window.history.pushState(null, '', '/')
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    routeFetch(String(input), (init?.method ?? 'GET').toUpperCase()))
})

afterEach(() => {
  queryClient.clear()
  fixtures.clear()
  uiDispatch = null
  vi.restoreAllMocks()
})

function makePair(
  shared: Partial<Ticket> = {},
  distinct: { first?: Partial<Ticket>; second?: Partial<Ticket> } = {},
): [Ticket, Ticket] {
  return [
    makeTicket({ ...shared, ...distinct.first, id: TICKET_A_ID, externalId: TICKET_A_EXTERNAL, title: 'First ticket' }),
    makeTicket({ ...shared, ...distinct.second, id: TICKET_B_ID, externalId: TICKET_B_EXTERNAL, title: 'Second ticket' }),
  ]
}

/**
 * Two tickets waiting on the same Manual QA round shape, with an older round each so the version
 * picker is on screen. Version 2 is live on both, which is the only version a draft can be typed
 * into — an older one renders read-only.
 */
function seedManualQaPair(): [Ticket, Ticket] {
  const pair = makePair({
    status: 'WAITING_MANUAL_QA',
    manualQa: {
      activeVersion: 2,
      completedRoundCount: 1,
      latestOutcome: null,
      artifactAvailability: { checklist: true, results: false, coverage: true, summary: false },
    },
  })
  seedTickets(...pair)
  for (const ticket of pair) {
    const fixture = fixtureFor(ticket)
    fixture.manualQaIndex = makeManualQaIndex()
    fixture.manualQaRounds = { 1: makeManualQaRound(1), 2: makeManualQaRound(2) }
    queryClient.setQueryData(['manual-qa', ticket.id, 'index'], fixture.manualQaIndex)
    queryClient.setQueryData(['manual-qa', ticket.id, 'version', 1], fixture.manualQaRounds[1])
    queryClient.setQueryData(['manual-qa', ticket.id, 'version', 2], fixture.manualQaRounds[2])
  }
  return pair
}

describe('cross-ticket state isolation', () => {
  it('leaves no interview answer, skip dialog or skip reason behind when another ticket is opened', async () => {
    const [first, second] = makePair({ status: 'WAITING_INTERVIEW_ANSWERS' })
    seedTickets(first, second)
    for (const ticket of [first, second]) {
      const interview = makeInterview()
      fixtureFor(ticket).interview = interview
      queryClient.setQueryData(['interview', ticket.id], interview)
    }

    renderApp()
    await openTicket(first)

    const answer = await screen.findByPlaceholderText('Type your answer here.')
    fireEvent.change(answer, { target: { value: INTERVIEW_ANSWER } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip All Questions' }))
    fireEvent.change(await screen.findByLabelText(/Why skip the rest/), { target: { value: SKIP_REASON } })

    await openTicket(second)

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Type your answer here.')).toHaveValue('')
    })
    expect(screen.queryByText('Skip Remaining Interview Questions')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(SKIP_REASON)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(INTERVIEW_ANSWER)).not.toBeInTheDocument()
  })

  it('leaves no pending-question skip form, description buffer or start error behind when another ticket is opened', async () => {
    const [first, second] = makePair({ status: 'DRAFT', availableActions: ['start'] })
    seedTickets(first, second)
    fixtureFor(first).questions = [makePendingQuestion(first.id, FIRST_QUESTION)]
    fixtureFor(second).questions = [makePendingQuestion(second.id, SECOND_QUESTION)]
    failStart = true

    renderApp()
    await openTicket(first)

    // Pending AI question: open the skip form and part-fill its reason.
    await screen.findByText(FIRST_QUESTION)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(await screen.findByLabelText(/Skip reason/), { target: { value: SKIP_REASON } })

    // Draft view: open the description editor in raw mode and type into it.
    fireEvent.click(screen.getByRole('button', { name: /^(Edit|Add) Description$/ }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Raw' }))
    fireEvent.change(await screen.findByLabelText('Ticket description'), { target: { value: DESCRIPTION_DRAFT } })

    // Draft view: fail a start so the error overlay is on screen.
    fireEvent.click(screen.getByRole('button', { name: /Start Ticket/ }))
    const startError = await screen.findByRole('alert')
    expect(startError).toHaveTextContent(START_FAILURE)

    await openTicket(second)

    // The second ticket's own question proves its panel is on screen before anything is asserted
    // absent. Waiting on a control instead would be circular: which controls the panel shows is
    // exactly what a leaked skip form changes.
    await screen.findByText(SECOND_QUESTION)
    expect(screen.queryByLabelText(/Skip reason/)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(SKIP_REASON)).not.toBeInTheDocument()
    // The description tabs are always on screen; what must not survive is the raw mode chosen on
    // the first ticket, and the open editor and its buffer.
    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByLabelText('Ticket description')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(DESCRIPTION_DRAFT)).not.toBeInTheDocument()
    expect(screen.queryByText(START_FAILURE)).not.toBeInTheDocument()
  })

  it('leaves no Manual QA draft behind when another ticket is opened', async () => {
    const [first, second] = seedManualQaPair()

    renderApp()
    await openTicket(first)

    // Fail the one checklist item and describe the failure. Both live in the round draft.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Fail' }))[0]!)
    const observation = await screen.findByPlaceholderText(QA_OBSERVATION_PLACEHOLDER)
    fireEvent.change(observation, { target: { value: QA_OBSERVATION } })

    await openTicket(second)

    await waitFor(() => {
      expect(screen.getByLabelText('Manual QA version')).toBeInTheDocument()
    })
    expect(screen.queryByDisplayValue(QA_OBSERVATION)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(QA_OBSERVATION_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('leaves no Manual QA version selection behind when another ticket is opened', async () => {
    const [first, second] = seedManualQaPair()

    renderApp()
    await openTicket(first)

    // Leave the live round for an older one, then go back: the first ticket must still be showing
    // its own live round rather than the version picked on the second.
    await waitFor(() => {
      expect(screen.getByLabelText('Manual QA version')).toHaveValue('2')
    })
    await openTicket(second)
    fireEvent.change(await screen.findByLabelText('Manual QA version'), { target: { value: '1' } })
    await waitFor(() => {
      expect(screen.getByLabelText('Manual QA version')).toHaveValue('1')
    })

    await openTicket(first)

    await waitFor(() => {
      expect(screen.getByLabelText('Manual QA version')).toHaveValue('2')
    })
  })

  it('leaves no error-view retry note behind when another ticket is opened', async () => {
    const [first, second] = makePair(
      { status: 'BLOCKED_ERROR', previousStatus: 'CODING', availableActions: ['retry'] },
      {
        first: { errorMessage: FIRST_ERROR_MESSAGE },
        second: { errorMessage: SECOND_ERROR_MESSAGE },
      },
    )
    seedTickets(first, second)

    renderApp()
    await openTicket(first)

    fireEvent.click(await screen.findByRole('button', { name: /Retry with extra note/ }))
    const note = await screen.findByPlaceholderText(RETRY_NOTE_PLACEHOLDER)
    fireEvent.change(note, { target: { value: RETRY_NOTE } })

    await openTicket(second)

    // Matched by text, not by role: a leaked dialog is modal, and every role query outside it would
    // come back empty for that reason rather than because the view had re-rendered.
    await screen.findByText(SECOND_ERROR_MESSAGE)
    expect(screen.queryByPlaceholderText(RETRY_NOTE_PLACEHOLDER)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(RETRY_NOTE)).not.toBeInTheDocument()
  })
})
