import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST } from '@/test/factories'
import { renderWithProviders } from '@/test/renderHelpers'
import { createArtifactFactory } from '@/test/workspaceArtifactBuilders'
import type { TicketArtifact, TicketArtifactCollectionState } from '@/hooks/useTicketArtifacts'
import { PhaseArtifactsPanel } from '../PhaseArtifactsPanel'
import { ArtifactContent } from '../ArtifactContentViewer'
import { CouncilStatusIcon } from '../CouncilStatusIcon'
import {
  buildCouncilMemberArtifacts,
  buildFullAnswerMemberArtifacts,
  getDraftingRoundMeta,
} from '../councilArtifacts'
import {
  CouncilMemberControlContext,
  describeStopResult,
  getDraftMemberControl,
  getVoteMemberControl,
  type CouncilMemberControlScope,
} from '../councilMemberControl'

const A = 'vendor/model-a'
const B = 'vendor/model-b'
const C = 'vendor/model-c'
const MEMBERS = [A, B, C]

const LIVE_DELIBERATING: CouncilMemberControlScope = { ticketId: TEST.ticketId, phase: 'COUNCIL_DELIBERATING' }
const LIVE_PRD_DRAFTING: CouncilMemberControlScope = { ticketId: TEST.ticketId, phase: 'DRAFTING_PRD' }
const LIVE_PRD_VOTING: CouncilMemberControlScope = { ticketId: TEST.ticketId, phase: 'COUNCIL_VOTING_PRD' }

/** The warning when the stopped model was the last one working: the step ends on the spot. */
const QUORUM_FAILS_NOW = 'so the step will fail and the ticket will stop with an error. You can retry the whole step from there.'
/** The warning while other models still work: retrying one of them can still save the step. */
const QUORUM_FAILS_UNLESS = 'Unless you retry another model in time, the step will fail and the ticket will stop with an error.'

const { makeArtifact, resetArtifactIds } = createArtifactFactory()

type Outcome = 'pending' | 'completed' | 'timed_out' | 'invalid_output' | 'failed' | 'stopped'

function draft(memberId: string, outcome: Outcome) {
  return outcome === 'completed' ? { memberId, outcome, content: `Draft from ${memberId}?` } : { memberId, outcome }
}

function roundArtifact(
  phase: string,
  artifactType: string,
  outcomes: Record<string, Outcome>,
  round: { isFinal?: boolean; minQuorum?: number } = {},
): TicketArtifact {
  return makeArtifact({
    phase,
    artifactType,
    content: JSON.stringify({
      drafts: Object.entries(outcomes).map(([memberId, outcome]) => draft(memberId, outcome)),
      memberOutcomes: outcomes,
      isFinal: round.isFinal ?? false,
      minQuorum: round.minQuorum ?? 2,
    }),
  })
}

function interviewDrafts(outcomes: Record<string, Outcome>, round?: { isFinal?: boolean; minQuorum?: number }) {
  return roundArtifact('COUNCIL_DELIBERATING', 'interview_drafts', outcomes, round)
}

function prdArtifacts(answers: Record<string, Outcome>, drafts: Record<string, Outcome>, round?: { minQuorum?: number }) {
  return [
    roundArtifact('DRAFTING_PRD', 'prd_full_answers', answers, round),
    roundArtifact('DRAFTING_PRD', 'prd_drafts', drafts, round),
  ]
}

function successfulArtifactState(artifacts: TicketArtifact[]): TicketArtifactCollectionState {
  return {
    artifacts,
    status: 'success',
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(async () => undefined),
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(status = 200, body: unknown = { success: true }) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(status, body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentRequest(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url, body: JSON.parse(String(init?.body)) as unknown }
}

function panelElement(phase: string, artifacts: TicketArtifact[], scope: CouncilMemberControlScope | null) {
  return (
    <CouncilMemberControlContext.Provider value={scope}>
      <PhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        ticketId={TEST.ticketId}
        councilMemberCount={MEMBERS.length}
        councilMemberNames={MEMBERS}
        artifactState={successfulArtifactState(artifacts)}
      />
    </CouncilMemberControlContext.Provider>
  )
}

function renderPanel(phase: string, artifacts: TicketArtifact[], scope: CouncilMemberControlScope | null) {
  return renderWithProviders(panelElement(phase, artifacts, scope))
}

/** Opens a member chip. In `DRAFTING_PRD` index 0 is Part 1 and index 1 is Part 2. */
function openChip(modelName: string, index = 0) {
  const chips = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-label')?.startsWith(modelName)
    || button.textContent?.startsWith(modelName))
  fireEvent.click(chips[index]!)
  return screen.getByRole('dialog')
}

function controlFor(phase: string, artifacts: TicketArtifact[], chipKey: string) {
  const drafts = buildCouncilMemberArtifacts(phase, artifacts, MEMBERS, false)
  const answers = buildFullAnswerMemberArtifacts(phase, artifacts, MEMBERS)
  const chip = [...drafts, ...answers].find((candidate) => candidate.key === chipKey)
  if (!chip) throw new Error(`No chip ${chipKey}`)
  return getDraftMemberControl(phase, chip, drafts, answers, getDraftingRoundMeta(phase, artifacts))
}

beforeEach(() => {
  resetArtifactIds()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getDraftMemberControl', () => {
  it.each([
    ['the round is final', [interviewDrafts({ [A]: 'pending', [B]: 'pending' }, { isFinal: true })]],
    ['no model is still working', [interviewDrafts({ [A]: 'completed', [B]: 'failed', [C]: 'stopped' })]],
    ['the round artifact does not exist yet', []],
  ])('offers nothing when %s', (_case, artifacts) => {
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${A}`)).toBeNull()
  })

  it('offers nothing outside the drafting statuses', () => {
    const artifacts = [roundArtifact('REFINING_PRD', 'prd_drafts', { [A]: 'pending', [B]: 'pending' })]
    expect(controlFor('REFINING_PRD', artifacts, `REFINING_PRD:${A}`)).toBeNull()
  })

  it('offers Stop only on a model that is still working', () => {
    const artifacts = [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'failed' })]
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${A}`)?.canStop).toBe(true)
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${B}`)?.canStop).toBe(false)
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${C}`)?.canStop).toBe(false)
  })

  it.each([
    // [what, outcomes, minQuorum, warning]
    ['the other model still working keeps the quorum in reach', { [A]: 'pending', [B]: 'pending', [C]: 'completed' }, 2, null],
    ['a finished result counts toward the quorum', { [A]: 'pending', [B]: 'completed', [C]: 'failed' }, 2, `This step needs 2 results and only 1 can still arrive, ${QUORUM_FAILS_NOW}`],
    ['the stopped model no longer counts', { [A]: 'pending', [B]: 'pending', [C]: 'failed' }, 2, `This step needs 2 results and only 1 can still arrive. ${QUORUM_FAILS_UNLESS}`],
    ['ended models never count', { [A]: 'pending', [B]: 'failed', [C]: 'stopped' }, 1, `This step needs 1 result and none can still arrive, ${QUORUM_FAILS_NOW}`],
    ['a round without a quorum never warns', { [A]: 'pending', [B]: 'failed' }, undefined, null],
  ] as const)('warns about the quorum on a stop when %s', (_case, outcomes, minQuorum, warning) => {
    const artifacts = [minQuorum === undefined
      ? makeArtifact({
          phase: 'COUNCIL_DELIBERATING',
          artifactType: 'interview_drafts',
          content: JSON.stringify({ drafts: Object.entries(outcomes).map(([memberId, outcome]) => draft(memberId, outcome)), isFinal: false }),
        })
      : interviewDrafts(outcomes, { minQuorum })]

    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${A}`)?.stop.warning).toBe(warning)
  })

  it('words the stop confirmation', () => {
    const artifacts = [interviewDrafts({ [A]: 'pending', [B]: 'pending', [C]: 'completed' })]
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${A}`)?.stop).toEqual({
      question: 'Stop model-a?',
      consequence: 'Its unfinished work is thrown away and the step goes on with the other models.',
      warning: null,
      confirmLabel: 'Stop model',
      destructive: true,
    })
  })

  it('says the step moves on when the stopped model is the last one working', () => {
    const artifacts = [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'completed' })]
    expect(controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${A}`)?.stop.consequence)
      .toBe('Its unfinished work is thrown away and the step moves on without it.')
  })

  it('names the finished Part 1 answers a PRD stop throws away', () => {
    const artifacts = prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'pending', [B]: 'pending' })
    expect(controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:${A}`)?.stop.consequence)
      .toBe('Its finished answers are thrown away for good. Its unfinished work is thrown away and the step goes on with the other models.')
  })

  it.each([
    ['a working model', A, {
      question: 'Restart model-a?',
      consequence: 'Its unfinished work is thrown away. It starts this step again with a full new time limit.',
      confirmLabel: 'Restart model',
      destructive: false,
    }],
    ['a model that finished', B, {
      question: 'Retry model-b?',
      consequence: 'Its finished draft is thrown away for good. It starts this step again with a full new time limit. If the new run fails, model-b counts as failed.',
      confirmLabel: 'Retry model',
      destructive: true,
    }],
    ['a model that ended without a result', C, {
      question: 'Retry model-c?',
      consequence: 'It starts this step again with a full new time limit.',
      confirmLabel: 'Retry model',
      destructive: false,
    }],
  ])('words the retry of %s', (_case, memberId, copy) => {
    const artifacts = [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'timed_out' })]
    const control = controlFor('COUNCIL_DELIBERATING', artifacts, `COUNCIL_DELIBERATING:${memberId}`)
    expect(control?.retry).toEqual({ ...copy, warning: null })
    expect(control?.part).toBeUndefined()
  })

  describe('in DRAFTING_PRD', () => {
    it('restarts both parts from a Part 1 chip, and offers Stop while the model writes its draft', () => {
      // Part 1 is done and the model is on Part 2: it is still working, so the
      // Part 1 window can stop it too, and a restart throws both kinds of work away.
      const artifacts = prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'pending', [B]: 'pending' })
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:fullanswers:${A}`)
      expect(control?.part).toBe('full_answers')
      expect(control?.canStop).toBe(true)
      expect(control?.retry.question).toBe('Restart model-a?')
      expect(control?.retry.consequence).toBe(
        'Its finished answers are thrown away for good. Its unfinished work is thrown away. It redoes both parts with a full new time limit. If the new run fails, model-a counts as failed.',
      )
    })

    it('names both finished parts when a finished model is retried from Part 1', () => {
      const artifacts = prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'completed', [B]: 'pending' })
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:fullanswers:${A}`)
      expect(control?.canStop).toBe(false)
      expect(control?.retry.question).toBe('Retry model-a?')
      expect(control?.retry.consequence).toBe(
        'Its finished answers and PRD draft are thrown away for good. It redoes both parts with a full new time limit. If the new run fails, model-a counts as failed.',
      )
    })

    it('throws away only the draft when a finished model is retried from Part 2', () => {
      const artifacts = prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'completed', [B]: 'pending' })
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:${A}`)
      expect(control?.retry.consequence).toBe(
        'Its finished draft is thrown away for good. It keeps its Part 1 answers and redoes only the PRD draft, with a full new time limit. If the new run fails, model-a counts as failed.',
      )
    })

    it('keeps finished answers when retried from the Part 2 chip', () => {
      const artifacts = prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'pending', [B]: 'pending' })
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:${A}`)
      expect(control?.part).toBe('prd_draft')
      expect(control?.canStop).toBe(true)
      expect(control?.retry.consequence).toBe(
        'Its unfinished work is thrown away. It keeps its Part 1 answers and redoes only the PRD draft, with a full new time limit.',
      )
    })

    it('redoes both parts from the Part 2 chip while Part 1 is unfinished', () => {
      const artifacts = prdArtifacts({ [A]: 'pending', [B]: 'pending' }, { [A]: 'pending', [B]: 'pending' })
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:${A}`)
      expect(control?.part).toBe('prd_draft')
      expect(control?.retry.consequence).toBe('Its unfinished work is thrown away. It redoes both parts with a full new time limit.')
    })

    it('counts the quorum on the PRD drafts, not on the Full Answers', () => {
      // Two Part 1 answers are finished, but only one draft can still arrive:
      // model-b is still drafting and model-c's draft failed.
      const artifacts = prdArtifacts(
        { [A]: 'pending', [B]: 'completed', [C]: 'completed' },
        { [A]: 'pending', [B]: 'pending', [C]: 'failed' },
      )
      const control = controlFor('DRAFTING_PRD', artifacts, `DRAFTING_PRD:fullanswers:${A}`)
      expect(control?.canStop).toBe(true)
      expect(control?.stop.warning).toBe(`This step needs 2 results and only 1 can still arrive. ${QUORUM_FAILS_UNLESS}`)
    })
  })
})

describe('getVoteMemberControl', () => {
  it('says a finished vote is lost for good', () => {
    const control = getVoteMemberControl(B, [{ memberId: A, outcome: 'pending' }, { memberId: B, outcome: 'completed' }], 2)
    expect(control.canStop).toBe(false)
    expect(control.retry.consequence).toBe(
      'Its finished vote is thrown away for good. It starts this step again with a full new time limit. If the new run fails, model-b counts as failed.',
    )
  })
})

describe('describeStopResult', () => {
  it.each([
    ['stopped', null],
    ['completed', 'model-a finished before it could be stopped.'],
    ['timed_out', 'model-a ended on its own before it could be stopped.'],
    ['failed', 'model-a ended on its own before it could be stopped.'],
  ])('describes a stop that came back %s', (outcome, notice) => {
    expect(describeStopResult(A, outcome)).toBe(notice)
  })
})

describe('member dialog controls in a drafting step', () => {
  it('offers Stop and Retry on a working model, and only Retry on one that finished', async () => {
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    expect(within(dialog).getByRole('button', { name: 'Stop model-a' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Retry model-a' })).toBeInTheDocument()
    // Opening a working model must not greet the reader with Stop focused and its tooltip open.
    expect(dialog).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const finished = openChip('model-b')
    expect(within(finished).queryByRole('button', { name: 'Stop model-b' })).not.toBeInTheDocument()
    expect(within(finished).getByRole('button', { name: 'Retry model-b' })).toBeInTheDocument()
  })

  it.each([
    ['without the live council view', null, [interviewDrafts({ [A]: 'pending', [B]: 'pending' })]],
    ['for another step', LIVE_PRD_DRAFTING, [interviewDrafts({ [A]: 'pending', [B]: 'pending' })]],
    ['once the round is final', LIVE_DELIBERATING, [interviewDrafts({ [A]: 'pending', [B]: 'pending' }, { isFinal: true })]],
    ['once no model is working', LIVE_DELIBERATING, [interviewDrafts({ [A]: 'completed', [B]: 'timed_out', [C]: 'completed' })]],
  ])('offers nothing %s', (_case, scope, artifacts) => {
    renderPanel('COUNCIL_DELIBERATING', artifacts, scope)

    const dialog = openChip('model-a')
    expect(within(dialog).queryByRole('button', { name: /^(Stop|Retry) model-a$/ })).not.toBeInTheDocument()
  })

  it('stops a model only after the person confirms', async () => {
    const fetchMock = stubFetch(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A, outcome: 'stopped' })
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending', [C]: 'completed' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))

    const strip = within(dialog).getByRole('group', { name: 'Stop model-a?' })
    expect(strip).toHaveTextContent('Stop model-a? Its unfinished work is thrown away and the step goes on with the other models.')
    expect(strip).not.toHaveTextContent('This step needs')
    expect(within(strip).getByRole('button', { name: 'Stop model' })).toHaveClass('bg-destructive')
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(within(strip).getByRole('button', { name: 'Stop model' }))

    await waitFor(() => expect(strip).not.toBeInTheDocument())
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/stop',
      body: { phase: 'COUNCIL_DELIBERATING', memberId: A },
    })
  })

  it('cancels without sending anything', () => {
    const fetchMock = stubFetch()
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry model-a' }))
    const strip = within(dialog).getByRole('group', { name: 'Restart model-a?' })
    // Restarting a model that is still working loses nothing finished.
    expect(within(strip).getByRole('button', { name: 'Restart model' })).toHaveClass('bg-primary')
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel' }))

    expect(strip).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('warns in the confirmation when the stop leaves the step short of its quorum', () => {
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending', [C]: 'failed' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))

    expect(within(dialog).getByRole('group', { name: 'Stop model-a?' }))
      .toHaveTextContent(`This step needs 2 results and only 1 can still arrive. ${QUORUM_FAILS_UNLESS}`)
  })

  it('shows the server refusal inline and keeps the confirmation open', async () => {
    stubFetch(409, { error: 'model-a already finished.', code: 'MEMBER_FINISHED' })
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    const strip = within(dialog).getByRole('group', { name: 'Stop model-a?' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Stop model' }))

    expect(await within(strip).findByRole('alert')).toHaveTextContent('Could not stop the model (HTTP 409: model-a already finished.)')
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel' }))
    expect(strip).not.toBeInTheDocument()
  })

  it('says so when the model finished before the stop reached it', async () => {
    stubFetch(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A, outcome: 'completed' })
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model' }))

    expect(await within(dialog).findByText('model-a finished before it could be stopped.')).toHaveAttribute('role', 'status')
  })

  it('keeps the notice after the stop the model beat ends the round', async () => {
    stubFetch(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A, outcome: 'completed' })
    const view = renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'completed' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model' }))
    await within(dialog).findByText('model-a finished before it could be stopped.')

    // The refreshed artifacts show nobody working: the round is over.
    view.rerender(panelElement('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'completed', [B]: 'completed', [C]: 'completed' })], LIVE_DELIBERATING))
    expect(screen.queryByRole('button', { name: 'Retry model-a' })).not.toBeInTheDocument()
    expect(screen.getByText('model-a finished before it could be stopped.')).toBeInTheDocument()
  })

  it('shows an unconfirmed stop inline', async () => {
    stubFetch(500, { error: 'This model\'s turn could not be ended cleanly.', code: 'STOP_UNCONFIRMED' })
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be ended cleanly')
  })

  it('sends one request when the confirm button is clicked twice before it re-renders', async () => {
    const fetchMock = stubFetch(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A, outcome: 'stopped' })
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    const confirm = within(dialog).getByRole('button', { name: 'Stop model' })
    // Both clicks in one act: React renders only afterwards, so the button is
    // still enabled for the second click and only the send guard stops it.
    act(() => {
      confirm.click()
      confirm.click()
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still shows a refusal that arrives after the round ended', async () => {
    let answer!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'completed' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // model-a finished on its own while the stop was on its way.
    view.rerender(panelElement('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'completed', [B]: 'completed', [C]: 'completed' })], LIVE_DELIBERATING))
    answer(jsonResponse(409, { error: 'This step is no longer running.', code: 'STEP_NOT_RUNNING' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This step is no longer running.')
    expect(within(dialog).queryByRole('button', { name: /^(Stop|Retry) model-/ })).not.toBeInTheDocument()
  })

  it('keeps the notice once the ticket has moved on to the next step', async () => {
    stubFetch(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A, outcome: 'completed' })
    const view = renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'completed', [C]: 'completed' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop model' }))
    await within(dialog).findByText('model-a finished before it could be stopped.')

    // The live council view gives up its scope once the ticket leaves the step.
    view.rerender(panelElement('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'completed', [B]: 'completed', [C]: 'completed' }, { isFinal: true })], null))
    expect(screen.getByText('model-a finished before it could be stopped.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Stop|Retry) model-/ })).not.toBeInTheDocument()
  })

  it('locks the controls and shows a spinner while the request runs', async () => {
    let answer!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve })))
    renderPanel('COUNCIL_DELIBERATING', [interviewDrafts({ [A]: 'pending', [B]: 'pending' })], LIVE_DELIBERATING)

    const dialog = openChip('model-a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry model-a' }))
    const strip = within(dialog).getByRole('group', { name: 'Restart model-a?' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Restart model' }))

    await waitFor(() => expect(within(strip).getByRole('button', { name: 'Restart model' })).toBeDisabled())
    expect(within(strip).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Stop model-a' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Retry model-a' })).toBeDisabled()
    expect(strip.querySelector('.animate-spin')).not.toBeNull()

    answer(jsonResponse(200, { success: true, phase: 'COUNCIL_DELIBERATING', memberId: A }))
    await waitFor(() => expect(strip).not.toBeInTheDocument())
  })

  it.each([
    ['the Part 1 chip', 0, 'full_answers', 'It redoes both parts with a full new time limit.'],
    ['the Part 2 chip', 1, 'prd_draft', 'It keeps its Part 1 answers and redoes only the PRD draft, with a full new time limit.'],
  ])('retries a PRD model from %s', async (_case, chipIndex, part, scopeSentence) => {
    const fetchMock = stubFetch(200, { success: true, phase: 'DRAFTING_PRD', memberId: A })
    renderPanel('DRAFTING_PRD', prdArtifacts({ [A]: 'completed', [B]: 'pending' }, { [A]: 'completed', [B]: 'pending' }), LIVE_PRD_DRAFTING)

    const dialog = openChip('model-a', chipIndex)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry model-a' }))
    const strip = within(dialog).getByRole('group', { name: 'Retry model-a?' })
    expect(strip).toHaveTextContent(scopeSentence)
    fireEvent.click(within(strip).getByRole('button', { name: 'Retry model' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/retry',
      body: { phase: 'DRAFTING_PRD', memberId: A, part },
    })
  })
})

describe('voter badge controls in a voting step', () => {
  function voteContent(voterOutcomes: Record<string, Outcome>, round: { isFinal?: boolean } = {}) {
    return JSON.stringify({
      drafts: MEMBERS.map((memberId) => draft(memberId, 'completed')),
      votes: [{ voterId: B, draftId: A, totalScore: 80, scores: [{ category: 'Coverage of requirements', score: 80 }] }],
      voterOutcomes,
      isFinal: round.isFinal ?? false,
      minQuorum: 2,
    })
  }

  function votesElement(content: string, scope: CouncilMemberControlScope | null) {
    return (
      <CouncilMemberControlContext.Provider value={scope}>
        <ArtifactContent artifactId="vote-details" phase="COUNCIL_VOTING_PRD" content={content} />
      </CouncilMemberControlContext.Provider>
    )
  }

  function renderVotes(content: string, scope: CouncilMemberControlScope | null) {
    return renderWithProviders(votesElement(content, scope))
  }

  it('offers Stop only on voters still scoring, and Retry on every voter', () => {
    renderVotes(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'failed' }), LIVE_PRD_VOTING)

    expect(screen.getByRole('button', { name: 'Stop model-a' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop model-b' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop model-c' })).not.toBeInTheDocument()
    for (const name of ['model-a', 'model-b', 'model-c']) {
      expect(screen.getByRole('button', { name: `Retry ${name}` })).toBeInTheDocument()
    }
  })

  it.each([
    ['without the live council view', voteContent({ [A]: 'pending', [B]: 'completed' }), null],
    ['for another step', voteContent({ [A]: 'pending', [B]: 'completed' }), LIVE_DELIBERATING],
    ['once the vote is final', voteContent({ [A]: 'pending', [B]: 'completed' }, { isFinal: true }), LIVE_PRD_VOTING],
    ['once every voter is done', voteContent({ [A]: 'stopped', [B]: 'completed' }), LIVE_PRD_VOTING],
  ])('offers nothing %s', (_case, content, scope) => {
    renderVotes(content, scope)

    expect(screen.getAllByText('model-b').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^(Stop|Retry) model-/ })).not.toBeInTheDocument()
  })

  it('confirms under the voter row and restarts the chosen voter', async () => {
    const fetchMock = stubFetch(200, { success: true, phase: 'COUNCIL_VOTING_PRD', memberId: B })
    renderVotes(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'failed' }), LIVE_PRD_VOTING)

    fireEvent.click(screen.getByRole('button', { name: 'Retry model-b' }))

    const strip = screen.getByRole('group', { name: 'Retry model-b?' })
    expect(strip).toHaveTextContent(
      'Retry model-b? Its finished vote is thrown away for good. It starts this step again with a full new time limit. If the new run fails, model-b counts as failed.',
    )
    // Directly under the badges it came from.
    expect(within(strip.previousElementSibling as HTMLElement).getByRole('button', { name: 'Retry model-b' })).toBeInTheDocument()

    fireEvent.click(within(strip).getByRole('button', { name: 'Retry model' }))

    await waitFor(() => expect(strip).not.toBeInTheDocument())
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/retry',
      body: { phase: 'COUNCIL_VOTING_PRD', memberId: B },
    })
  })

  it('still shows a refusal that arrives after the vote ended', async () => {
    let answer!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderVotes(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'completed' }), LIVE_PRD_VOTING)

    fireEvent.click(screen.getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Stop model-a?' })).getByRole('button', { name: 'Stop model' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    view.rerender(votesElement(voteContent({ [A]: 'completed', [B]: 'completed', [C]: 'completed' }, { isFinal: true }), LIVE_PRD_VOTING))
    answer(jsonResponse(409, { error: 'This step is no longer running.', code: 'STEP_NOT_RUNNING' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This step is no longer running.')
    expect(screen.queryByRole('button', { name: /^(Stop|Retry) model-/ })).not.toBeInTheDocument()
  })

  it('keeps the notice, without buttons, once the ticket has moved on', async () => {
    stubFetch(200, { success: true, phase: 'COUNCIL_VOTING_PRD', memberId: A, outcome: 'completed' })
    // model-a is the only voter still at work; model-c already ended, so
    // nothing is left running once model-a turns out to have finished.
    const view = renderVotes(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'failed' }), LIVE_PRD_VOTING)

    fireEvent.click(screen.getByRole('button', { name: 'Stop model-a' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Stop model-a?' })).getByRole('button', { name: 'Stop model' }))
    await screen.findByText('model-a finished before it could be stopped.')

    // A stale artifact still showing the vote open must not bring the buttons back.
    view.rerender(votesElement(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'failed' }), null))
    expect(screen.getByText('model-a finished before it could be stopped.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Stop|Retry) model-/ })).not.toBeInTheDocument()
  })

  it('warns before a stop that leaves the vote short of its quorum', async () => {
    const fetchMock = stubFetch(200, { success: true, phase: 'COUNCIL_VOTING_PRD', memberId: A, outcome: 'stopped' })
    renderVotes(voteContent({ [A]: 'pending', [B]: 'completed', [C]: 'failed' }), LIVE_PRD_VOTING)

    fireEvent.click(screen.getByRole('button', { name: 'Stop model-a' }))
    const strip = screen.getByRole('group', { name: 'Stop model-a?' })
    expect(strip).toHaveTextContent(`This step needs 2 results and only 1 can still arrive, ${QUORUM_FAILS_NOW}`)

    fireEvent.click(within(strip).getByRole('button', { name: 'Stop model' }))

    await waitFor(() => expect(strip).not.toBeInTheDocument())
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/stop',
      body: { phase: 'COUNCIL_VOTING_PRD', memberId: A },
    })
  })
})

describe('CouncilStatusIcon', () => {
  it('shows a stopped model with a still, neutral icon instead of the working one', () => {
    const { container } = render(<CouncilStatusIcon outcome="stopped" action="drafting" />)
    const icon = container.querySelector('svg')

    expect(icon).toHaveClass('lucide-circle-stop', 'text-slate-500')
    expect(icon?.getAttribute('class')).not.toMatch(/animate-|text-(red|blue)-/)
  })
})
