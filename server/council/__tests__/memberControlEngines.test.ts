import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockOpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, PromptSessionOptions } from '../../opencode/types'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { makeInterviewQuestion, makeInterviewYaml, makePrdYaml, TEST } from '../../test/factories'
import { COUNCIL_MEMBER_STOPPED_ERROR } from '@shared/councilMembers'
import { generateDrafts } from '../drafter'
import { conductVoting } from '../voter'
import { draftPRD } from '../../phases/prd/draft'
import {
  hasLiveCouncilRound,
  resetCouncilRounds,
  retryCouncilMember,
  stopCouncilMember,
} from '../memberControl'
import { VOTING_RUBRIC_INTERVIEW, type DraftProgressEvent, type DraftResult, type MemberOutcome, type Vote } from '../types'

const repoManager = createTestRepoManager('council-member-control-')
const MODEL_A = 'test/model-a'
const MODEL_B = 'test/model-b'
const MEMBERS = [
  { modelId: MODEL_A, name: 'Model A' },
  { modelId: MODEL_B, name: 'Model B' },
]
const LONG_TIMEOUT_MS = 300_000

/**
 * `stall` never answers until its prompt is aborted; `hang` ignores the abort
 * too, like a prompt request OpenCode leaves pending; a string is the answer.
 */
type Script = Array<string | 'stall' | 'hang'>

/**
 * Answers each model from its own script, in order.
 *
 * Models are told apart by the model id on the prompt, so a script describes
 * one member's attempts whatever order the sessions are created in.
 */
class ScriptedAdapter extends MockOpenCodeAdapter {
  readonly prompts: Array<{ model: string; sessionId: string }> = []
  readonly aborted: string[] = []
  private readonly scripts: Map<string, Script>

  constructor(scripts: Record<string, Script>) {
    super()
    this.scripts = new Map(Object.entries(scripts).map(([model, script]) => [model, [...script]]))
  }

  promptsFor(model: string): string[] {
    return this.prompts.filter((prompt) => prompt.model === model).map((prompt) => prompt.sessionId)
  }

  override async promptSession(
    sessionId: string,
    parts: PromptPart[],
    signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string> {
    const model = options?.model ? `${options.model.providerID}/${options.model.modelID}` : 'unknown'
    this.prompts.push({ model, sessionId })
    const next = this.scripts.get(model)?.shift()
    if (next === 'hang') return new Promise(() => {})
    if (next === 'stall') {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const abortError = new Error('Aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        }, { once: true })
      })
    }
    if (typeof next === 'string') this.mockResponses.set(sessionId, next)
    return super.promptSession(sessionId, parts, signal, options)
  }

  override async abortSession(sessionId: string): Promise<boolean> {
    this.aborted.push(sessionId)
    return true
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function scorecard(): string {
  const categories = VOTING_RUBRIC_INTERVIEW.map((item) => item.category)
  const draft = (label: string, score: number) => [
    `  ${label}:`,
    ...categories.map((category) => `    ${category}: ${score}`),
    `    total_score: ${score * categories.length}`,
  ]
  return ['draft_scores:', ...draft('Draft 1', 18), ...draft('Draft 2', 12)].join('\n')
}

const GENERATED_BY = { winner_model: MODEL_A, generated_at: TEST.timestamp }

function resolvedFullAnswers(): string {
  return makeInterviewYaml({
    status: 'draft',
    generated_by: GENERATED_BY,
    questions: [makeInterviewQuestion({
      answer: {
        skipped: false,
        selected_option_ids: [],
        free_text: 'Keep the existing retry behaviour.',
        answered_by: 'ai_skip',
        answered_at: TEST.timestamp,
        skip_reason: null,
      },
    })],
  })
}

describe('stopping and restarting one council member', () => {
  beforeEach(() => {
    resetTestDb()
  })

  afterEach(() => {
    resetCouncilRounds()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  describe('drafting', () => {
    async function startDrafting(
      adapter: ScriptedAdapter,
      title: string,
      options: { timeoutMs?: number; validate?: (content: string) => { normalizedContent?: string } } = {},
    ) {
      const { ticket, paths } = await createInitializedTestTicket(repoManager, { title })
      const progress: DraftProgressEvent[] = []
      const run = generateDrafts(
        adapter,
        MEMBERS,
        [{ type: 'text', content: 'Draft the interview questions.' }],
        paths.worktreePath,
        options.timeoutMs ?? LONG_TIMEOUT_MS,
        undefined,
        undefined,
        undefined,
        (entry) => progress.push(entry),
        options.validate,
        { ticketId: ticket.id, phase: 'COUNCIL_DELIBERATING' },
      )
      return { ticket, run, progress }
    }

    it('stops a stuck drafter and settles the round without waiting for its timeout', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: ['Draft from A'], [MODEL_B]: ['stall'] })
      const { ticket, run, progress } = await startDrafting(adapter, 'Stop a drafter')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 1, 'B to start drafting')

      await expect(stopCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)).resolves.toBe('stopped')
      const result = await run

      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(result.deadlineReached).toBe(false)
      expect(result.drafts[1]).toMatchObject({ outcome: 'stopped', error: COUNCIL_MEMBER_STOPPED_ERROR, content: '' })
      expect(adapter.aborted).toContain(adapter.promptsFor(MODEL_B)[0])
      expect(progress).toContainEqual(expect.objectContaining({ memberId: MODEL_B, status: 'finished', outcome: 'stopped' }))
      expect(hasLiveCouncilRound(ticket.id, 'COUNCIL_DELIBERATING')).toBe(false)
    })

    it('stops a drafter whose prompt ignores the abort', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: ['Draft from A'], [MODEL_B]: ['hang'] })
      const { ticket, run } = await startDrafting(adapter, 'Stop a hung drafter')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 1, 'B to start drafting')

      await expect(stopCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)).resolves.toBe('stopped')
      await expect(run).resolves.toMatchObject({ memberOutcomes: { [MODEL_A]: 'completed', [MODEL_B]: 'stopped' } })
      expect(adapter.aborted).toContain(adapter.promptsFor(MODEL_B)[0])
    })

    it('restarts a stuck drafter in a fresh session and keeps its new draft', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: ['Draft from A'], [MODEL_B]: ['stall', 'Second draft from B'] })
      const { ticket, run, progress } = await startDrafting(adapter, 'Restart a drafter')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 1, 'B to start drafting')

      await retryCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)
      const result = await run

      const [firstSession, secondSession] = adapter.promptsFor(MODEL_B)
      expect(secondSession).toBeDefined()
      expect(secondSession).not.toBe(firstSession)
      expect(adapter.aborted).toContain(firstSession)
      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'completed' })
      expect(result.drafts[1]?.content).toBe('Second draft from B')
      const bEvents = progress.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.status)
      expect(bEvents).toEqual(['session_created', 'restarted', 'session_created', 'finished'])
    })

    it('keeps nothing a stopped drafter wrote, earlier rejected attempts included', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: ['Draft from A'], [MODEL_B]: ['not a draft', 'stall'] })
      const { ticket, run, progress } = await startDrafting(adapter, 'Stop after a rejected attempt', {
        validate: (content) => {
          if (content === 'not a draft') throw new Error('schema validation failed')
          return {}
        },
      })
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its structured retry')

      await stopCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)
      const result = await run

      expect(result.drafts[1]).toEqual(expect.objectContaining({ outcome: 'stopped', error: COUNCIL_MEMBER_STOPPED_ERROR }))
      expect(result.drafts[1]).not.toHaveProperty('rawAttempts')
      expect(result.drafts[1]).not.toHaveProperty('rawResponse')
      expect(result.drafts[1]?.structuredOutput).toBeUndefined()
      const finished = progress.find((entry) => entry.memberId === MODEL_B && entry.status === 'finished')
      expect(finished?.rawAttempts).toBeUndefined()
    })

    it('does not report a deadline once a timed-out drafter was restarted to a result', async () => {
      // B times out on the round's clock, is restarted, and drafts, while A keeps
      // the round open on a restart with its own clock. A is restarted halfway
      // through the round, so it still has half its time when B times out. The
      // clocks are faked but keep moving, so polling and I/O run as usual and
      // that half is a minute of real time, however slow the machine.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
      try {
        const timeoutMs = 120_000
        const adapter = new ScriptedAdapter({ [MODEL_A]: ['stall', 'stall'], [MODEL_B]: ['stall', 'Second draft from B'] })
        const { ticket, run, progress } = await startDrafting(adapter, 'Retry a timed-out drafter', { timeoutMs })
        await waitFor(() => adapter.promptsFor(MODEL_A).length === 1 && adapter.promptsFor(MODEL_B).length === 1, 'both to start')
        await vi.advanceTimersByTimeAsync(timeoutMs / 2)
        await retryCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_A)
        await vi.advanceTimersByTimeAsync(timeoutMs / 2)
        await waitFor(() => progress.some((entry) => entry.memberId === MODEL_B && entry.outcome === 'timed_out'), 'B to time out')

        await retryCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)
        await waitFor(() => progress.some((entry) => entry.memberId === MODEL_B && entry.outcome === 'completed'), 'B to draft')
        await stopCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_A)
        const result = await run

        expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'stopped', [MODEL_B]: 'completed' })
        expect(result.deadlineReached).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('redoes a finished draft while another model is still working, and keeps only the new one', async () => {
      const adapter = new ScriptedAdapter({
        [MODEL_A]: ['First draft from A', 'Second draft from A'],
        [MODEL_B]: ['stall'],
      })
      const { ticket, run, progress } = await startDrafting(adapter, 'Redo a finished draft')
      const finishedA = () => progress.filter((entry) => entry.memberId === MODEL_A && entry.status === 'finished').length
      await waitFor(() => finishedA() === 1 && adapter.promptsFor(MODEL_B).length === 1, 'A to finish and B to start')

      await retryCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_A)
      await waitFor(() => finishedA() === 2, 'A to finish again')
      await stopCouncilMember(ticket.id, 'COUNCIL_DELIBERATING', MODEL_B)
      const result = await run

      expect(result.drafts[0]).toMatchObject({ outcome: 'completed', content: 'Second draft from A' })
      expect(result.memberOutcomes[MODEL_B]).toBe('stopped')
    })
  })

  describe('voting', () => {
    const drafts: DraftResult[] = [
      { memberId: MODEL_A, content: 'Draft from A', outcome: 'completed', duration: 1 },
      { memberId: MODEL_B, content: 'Draft from B', outcome: 'completed', duration: 1 },
    ]

    async function startVoting(adapter: ScriptedAdapter, title: string) {
      const { ticket, paths } = await createInitializedTestTicket(repoManager, { title })
      const progress: Array<{ memberId: string; outcome: MemberOutcome; votes: Vote[] }> = []
      const run = conductVoting(
        adapter,
        MEMBERS,
        drafts,
        [{ type: 'text', content: 'Vote on the drafts.' }],
        paths.worktreePath,
        'interview_draft',
        LONG_TIMEOUT_MS,
        undefined,
        undefined,
        undefined,
        undefined,
        (entry) => progress.push({ memberId: entry.memberId, outcome: entry.outcome, votes: entry.votes }),
        undefined,
        { ticketId: ticket.id, phase: 'COUNCIL_VOTING_INTERVIEW' },
      )
      return { ticket, run, progress }
    }

    it('stops a stuck voter so its missing scorecard no longer holds the vote', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: [scorecard()], [MODEL_B]: ['stall'] })
      const { ticket, run } = await startVoting(adapter, 'Stop a voter')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 1, 'B to start voting')

      await expect(stopCouncilMember(ticket.id, 'COUNCIL_VOTING_INTERVIEW', MODEL_B)).resolves.toBe('stopped')
      const result = await run

      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(result.votes.every((vote) => vote.voterId === MODEL_A)).toBe(true)
      expect(result.voterDetails.find((detail) => detail.voterId === MODEL_B)?.error).toBe(COUNCIL_MEMBER_STOPPED_ERROR)
    })

    it('keeps nothing a stopped voter wrote, a rejected scorecard included', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: [scorecard()], [MODEL_B]: ['not a scorecard', 'stall'] })
      const { ticket, run } = await startVoting(adapter, 'Stop a voter after a rejected scorecard')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its structured retry')

      await stopCouncilMember(ticket.id, 'COUNCIL_VOTING_INTERVIEW', MODEL_B)
      const result = await run

      const detail = result.voterDetails.find((entry) => entry.voterId === MODEL_B)
      expect(detail?.error).toBe(COUNCIL_MEMBER_STOPPED_ERROR)
      expect(detail).not.toHaveProperty('rawAttempts')
      expect(detail).not.toHaveProperty('rawResponse')
    })

    it('restarts a voter and counts only its new scorecard', async () => {
      const adapter = new ScriptedAdapter({ [MODEL_A]: [scorecard(), scorecard()], [MODEL_B]: ['stall'] })
      const { ticket, run, progress } = await startVoting(adapter, 'Restart a voter')
      await waitFor(() => progress.some((entry) => entry.memberId === MODEL_A) && adapter.promptsFor(MODEL_B).length === 1, 'A to vote')

      await retryCouncilMember(ticket.id, 'COUNCIL_VOTING_INTERVIEW', MODEL_A)
      await waitFor(() => progress.filter((entry) => entry.memberId === MODEL_A).length === 3, 'A to vote again')
      await stopCouncilMember(ticket.id, 'COUNCIL_VOTING_INTERVIEW', MODEL_B)
      const result = await run

      expect(progress.filter((entry) => entry.memberId === MODEL_A).map((entry) => [entry.outcome, entry.votes.length])).toEqual([
        ['completed', 2],
        ['pending', 0],
        ['completed', 2],
      ])
      expect(result.votes.filter((vote) => vote.voterId === MODEL_A)).toHaveLength(2)
      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
    })
  })

  describe('PRD drafting', () => {
    async function startPrd(adapter: ScriptedAdapter, title: string, timeoutMs = LONG_TIMEOUT_MS) {
      const { ticket, paths } = await createInitializedTestTicket(repoManager, { title })
      const fullAnswerEvents: DraftProgressEvent[] = []
      const draftEvents: DraftProgressEvent[] = []
      const run = draftPRD(
        adapter,
        MEMBERS,
        { ticketId: TEST.externalId, title, description: 'Council stop and retry.', interview: makeInterviewYaml() },
        paths.worktreePath,
        { draftTimeoutMs: timeoutMs, minQuorum: 1, ticketId: ticket.id, ticketExternalId: TEST.externalId },
        undefined,
        undefined,
        undefined,
        undefined,
        (entry) => draftEvents.push(entry),
        (entry) => fullAnswerEvents.push(entry),
      )
      return { ticket, run, fullAnswerEvents, draftEvents }
    }

    it('stops a model during Full Answers, so its PRD draft never starts', async () => {
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), makePrdYaml()],
        [MODEL_B]: ['stall'],
      })
      const { ticket, run } = await startPrd(adapter, 'Stop during Full Answers')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 1, 'B to start Full Answers')

      await expect(stopCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B)).resolves.toBe('stopped')
      const result = await run

      expect(result.fullAnswerOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(result.drafts[1]?.error).toBe('PRD draft not started because the model was stopped during Full Answers')
      expect(adapter.promptsFor(MODEL_B)).toHaveLength(1)
    })

    it('times out a model whose prompt ignores the abort, so the step still ends', async () => {
      // Faked clocks that keep moving, as in the drafting deadline test above.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
      try {
        const timeoutMs = 120_000
        const adapter = new ScriptedAdapter({
          [MODEL_A]: [resolvedFullAnswers(), makePrdYaml()],
          [MODEL_B]: ['hang'],
        })
        const { run, draftEvents } = await startPrd(adapter, 'A PRD model that never answers', timeoutMs)
        let ended = false
        run.then(() => { ended = true }, () => { ended = true })
        await waitFor(
          () => draftEvents.some((entry) => entry.memberId === MODEL_A && entry.status === 'finished')
            && adapter.promptsFor(MODEL_B).length === 1,
          'A to draft and B to start Full Answers',
        )

        await vi.advanceTimersByTimeAsync(timeoutMs)
        await waitFor(() => ended, 'the step to end')
        const result = await run

        expect(result.fullAnswerOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'timed_out' })
        expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'timed_out' })
        expect(adapter.aborted).toContain(adapter.promptsFor(MODEL_B)[0])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps finished Full Answers when the PRD draft is restarted', async () => {
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), makePrdYaml()],
        [MODEL_B]: [resolvedFullAnswers(), 'stall', makePrdYaml()],
      })
      const { ticket, run, fullAnswerEvents, draftEvents } = await startPrd(adapter, 'Restart the PRD draft')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its PRD draft')

      await retryCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B, 'prd_draft')
      const result = await run

      expect(adapter.promptsFor(MODEL_B)).toHaveLength(3)
      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'completed' })
      expect(fullAnswerEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.status))
        .toEqual(['session_created', 'finished'])
      expect(draftEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.status))
        .toEqual(['session_created', 'restarted', 'session_created', 'finished'])
    })

    it('throws away finished Part 1 answers when the model is stopped during Part 2', async () => {
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), makePrdYaml()],
        [MODEL_B]: [resolvedFullAnswers(), 'stall'],
      })
      const { ticket, run, fullAnswerEvents } = await startPrd(adapter, 'Stop during the PRD draft')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its PRD draft')

      await stopCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B)
      const result = await run

      // Nothing of a stopped model reaches the vote or the refinement.
      expect(result.fullAnswerOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(result.memberOutcomes).toEqual({ [MODEL_A]: 'completed', [MODEL_B]: 'stopped' })
      expect(fullAnswerEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => [entry.status, entry.outcome]))
        .toEqual([['session_created', undefined], ['finished', 'completed'], ['finished', 'stopped']])
    })

    it('redoes Full Answers on a Part 2 retry when Part 1 did not finish usably', async () => {
      // A stays busy on its PRD draft so the round is still open for B's retry.
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), 'stall'],
        [MODEL_B]: ['not interview yaml', 'still not interview yaml', resolvedFullAnswers(), makePrdYaml()],
      })
      const { ticket, run, fullAnswerEvents, draftEvents } = await startPrd(adapter, 'Part 2 retry after a failed Part 1')
      await waitFor(
        () => fullAnswerEvents.some((entry) => entry.memberId === MODEL_B && entry.outcome === 'invalid_output'),
        'B to fail Full Answers',
      )
      // A step's session stays open after its prompt, so a failed step stops it.
      expect(adapter.aborted).toContain(adapter.promptsFor(MODEL_B)[0])

      await retryCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B, 'prd_draft')
      await waitFor(() => draftEvents.some((entry) => entry.memberId === MODEL_B && entry.outcome === 'completed'), 'B to draft')
      await stopCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_A)
      const result = await run

      expect(result.fullAnswerOutcomes[MODEL_B]).toBe('completed')
      expect(result.memberOutcomes[MODEL_B]).toBe('completed')
      expect(fullAnswerEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.status))
        .toContain('restarted')
    })

    it('redoes both parts on a Part 2 retry after a stop threw the Part 1 answers away', async () => {
      // A stays busy on its PRD draft so the round is still open for B's retry.
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), 'stall'],
        [MODEL_B]: [resolvedFullAnswers(), 'stall', resolvedFullAnswers(), makePrdYaml()],
      })
      const { ticket, run, fullAnswerEvents, draftEvents } = await startPrd(adapter, 'Retry after a Part 2 stop')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its PRD draft')
      await stopCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B)

      await retryCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B, 'prd_draft')
      await waitFor(() => draftEvents.some((entry) => entry.memberId === MODEL_B && entry.outcome === 'completed'), 'B to draft')
      await stopCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_A)
      const result = await run

      // Part 1 ran again in a session of its own, rather than being skipped.
      expect(fullAnswerEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.outcome ?? entry.status)).toEqual([
        'session_created',
        'completed',
        'stopped',
        'restarted',
        'session_created',
        'completed',
      ])
      expect(result.fullAnswerOutcomes[MODEL_B]).toBe('completed')
      expect(result.memberOutcomes[MODEL_B]).toBe('completed')
    })

    it('redoes both parts when the restart comes from Full Answers', async () => {
      const adapter = new ScriptedAdapter({
        [MODEL_A]: [resolvedFullAnswers(), makePrdYaml()],
        [MODEL_B]: [resolvedFullAnswers(), 'stall', resolvedFullAnswers(), makePrdYaml()],
      })
      const { ticket, run, fullAnswerEvents } = await startPrd(adapter, 'Restart from Full Answers')
      await waitFor(() => adapter.promptsFor(MODEL_B).length === 2, 'B to start its PRD draft')

      await retryCouncilMember(ticket.id, 'DRAFTING_PRD', MODEL_B, 'full_answers')
      const result = await run

      expect(adapter.promptsFor(MODEL_B)).toHaveLength(4)
      expect(result.fullAnswerOutcomes[MODEL_B]).toBe('completed')
      expect(result.memberOutcomes[MODEL_B]).toBe('completed')
      expect(fullAnswerEvents.filter((entry) => entry.memberId === MODEL_B).map((entry) => entry.status))
        .toEqual(['session_created', 'finished', 'restarted', 'session_created', 'finished'])
    })
  })
})
