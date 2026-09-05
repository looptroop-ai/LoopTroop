import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { clearProjectDatabaseCache } from '../../db/project'
import { sqlite } from '../../db/index'
import type { Message } from '../../opencode/types'
import { broadcaster } from '../../sse/broadcaster'
import {
  getAiDetails,
  recordAiTurnMetricFromPrompt,
  upsertAiTurnMetric,
} from '../../storage/aiTurnMetrics'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import type { OpenCodePromptCompletedEvent, OpenCodeSessionOwnership } from '../../workflow/runOpenCodePrompt'
import { ticketRouter } from '../tickets'

const repoManager = createTestRepoManager('ai-details-')
const app = new Hono()
app.route('/api', ticketRouter)

beforeEach(() => {
  clearProjectDatabaseCache()
  resetTestDb()
})

afterAll(() => {
  clearProjectDatabaseCache()
  repoManager.cleanup()
  sqlite.close()
})

function assistantMessage(input: {
  id: string
  created: number
  completed: number
  cost: number
  input: number
  output: number
  model?: string
  variant?: string
}): Message {
  return {
    id: input.id,
    role: 'assistant',
    info: {
      id: input.id,
      sessionID: 'session-current',
      role: 'assistant',
      providerID: 'provider',
      modelID: input.model ?? 'model-a',
      variant: input.variant ?? 'high',
      time: { created: input.created, completed: input.completed },
    },
    parts: [{
      id: `${input.id}-finish`,
      sessionID: 'session-current',
      messageID: input.id,
      type: 'step-finish',
      reason: 'tool-calls',
      cost: input.cost,
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: 2,
        cache: { read: 3, write: 4 },
      },
    }],
  }
}

function completionEvent(messages: Message[], latestId: string): OpenCodePromptCompletedEvent {
  return {
    session: { id: 'session-current' },
    parts: [{ type: 'text', content: 'current prompt' }],
    response: 'done',
    messages,
    responseMeta: {
      hasAssistantMessage: true,
      latestAssistantMessageId: latestId,
      latestAssistantWasEmpty: false,
      latestAssistantHasError: false,
      latestAssistantWasStale: false,
      latestStepFinishReason: 'stop',
    },
    attemptMeta: {
      outcome: 'clean',
      responseAccepted: true,
      discardedResponse: false,
      sessionErrored: false,
      latestAssistantErrored: false,
    },
    model: 'fallback/model',
    agent: 'build',
    variant: 'medium',
  }
}

describe('AI turn metrics', () => {
  it('records every assistant message in the current prompt segment without backfilling continuation history', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const ownership: OpenCodeSessionOwnership = {
      ticketId: ticket.id,
      phase: 'CODING',
      phaseAttempt: 2,
      memberId: 'fallback/model',
    }
    const oldAssistant = assistantMessage({
      id: 'assistant-old',
      created: 100,
      completed: 200,
      cost: 99,
      input: 900,
      output: 90,
    })
    const firstCurrent = assistantMessage({
      id: 'assistant-current-1',
      created: 1_000,
      completed: 1_300,
      cost: 0.25,
      input: 10,
      output: 5,
    })
    const secondCurrent = assistantMessage({
      id: 'assistant-current-2',
      created: 1_400,
      completed: 1_900,
      cost: 0.5,
      input: 20,
      output: 8,
    })
    const messages: Message[] = [
      { id: 'user-old', role: 'user', content: 'old prompt' },
      oldAssistant,
      { id: 'user-current', role: 'user', content: 'current prompt' },
      firstCurrent,
      secondCurrent,
    ]
    const event = completionEvent(messages, secondCurrent.id)
    const sent = vi.fn()
    broadcaster.addClient(ticket.id, {
      id: 'metrics-test',
      send: sent,
      close: () => undefined,
    })

    expect(recordAiTurnMetricFromPrompt(event, ownership)).toBe(true)
    expect(recordAiTurnMetricFromPrompt(event, ownership)).toBe(true)

    const details = getAiDetails(ticket.id, {
      scope: 'phase',
      phase: 'CODING',
      phaseAttempt: 2,
    })
    expect(details).toMatchObject({
      scope: 'phase',
      phase: 'CODING',
      phaseAttempt: 2,
      modelId: null,
      summary: {
        turns: 2,
        sessions: 1,
        costUsd: 0.75,
        tokens: {
          total: 61,
          input: 30,
          output: 13,
          reasoning: 4,
          cacheRead: 6,
          cacheWrite: 8,
        },
        timingMs: {
          total: 800,
          average: 400,
          longest: 500,
        },
        coverage: {
          costTurns: 2,
          tokenTurns: 2,
          timingTurns: 2,
        },
      },
    })
    expect(sent).toHaveBeenCalledWith(
      'ai_metrics',
      expect.any(String),
      expect.any(String),
    )
    expect(JSON.parse(sent.mock.calls.at(-1)?.[1] as string)).toMatchObject({
      ticketId: ticket.id,
      phase: 'CODING',
      phaseAttempt: 2,
      modelId: 'provider/model-a',
      updatedAt: expect.any(String),
    })
    broadcaster.removeClient(ticket.id, 'metrics-test')
    broadcaster.clearTicket(ticket.id)
  })

  it('aggregates lifecycle and model scopes while keeping missing provider values null', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    upsertAiTurnMetric({
      ticketId: ticket.id,
      phase: 'DRAFTING_PRD',
      phaseAttempt: 1,
      sessionId: 'session-a',
      assistantMessageId: 'message-a',
      modelId: 'provider/model-a',
      costUsd: 1.5,
      inputTokens: 100,
      durationMs: 250,
    })
    upsertAiTurnMetric({
      ticketId: ticket.id,
      phase: 'CODING',
      phaseAttempt: 1,
      sessionId: 'session-b',
      assistantMessageId: 'message-b',
      modelId: 'provider/model-b',
    })

    expect(getAiDetails(ticket.id, {
      scope: 'lifecycle',
      modelId: 'provider/model-b',
    })).toMatchObject({
      summary: {
        turns: 1,
        sessions: 1,
        costUsd: null,
        tokens: {
          total: null,
          input: null,
          output: null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
        },
        timingMs: {
          total: null,
          average: null,
          longest: null,
        },
        coverage: {
          costTurns: 0,
          tokenTurns: 0,
          timingTurns: 0,
        },
      },
    })
    expect(getAiDetails(ticket.id, { scope: 'lifecycle' })?.summary.turns).toBe(2)
  })
})

describe('GET /api/tickets/:ticketId/ai-details', () => {
  it('returns phase and lifecycle summaries with the documented response shape', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    upsertAiTurnMetric({
      ticketId: ticket.id,
      phase: 'CODING',
      phaseAttempt: 1,
      sessionId: 'session-route',
      assistantMessageId: 'message-route',
      modelId: 'provider/model',
      costUsd: 0.125,
      inputTokens: 12,
      outputTokens: 4,
      durationMs: 600,
    })

    const phaseResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/ai-details?scope=phase&phase=CODING&modelId=${encodeURIComponent('provider/model')}`,
    )
    expect(phaseResponse.status).toBe(200)
    expect(await phaseResponse.json()).toMatchObject({
      scope: 'phase',
      phase: 'CODING',
      phaseAttempt: 1,
      modelId: 'provider/model',
      summary: {
        turns: 1,
        costUsd: 0.125,
        tokens: { total: 16 },
        timingMs: { total: 600, average: 600, longest: 600 },
      },
      updatedAt: expect.any(String),
    })

    const lifecycleResponse = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/ai-details?scope=lifecycle`,
    )
    expect(lifecycleResponse.status).toBe(200)
    expect(await lifecycleResponse.json()).toMatchObject({
      scope: 'lifecycle',
      phase: null,
      phaseAttempt: null,
      modelId: null,
      summary: { turns: 1 },
    })
  })

  it('validates scope, phase, attempt, and ticket existence', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const encoded = encodeURIComponent(ticket.id)

    expect((await app.request(`/api/tickets/${encoded}/ai-details?scope=other`)).status).toBe(400)
    expect((await app.request(`/api/tickets/${encoded}/ai-details?scope=phase`)).status).toBe(400)
    expect((await app.request(`/api/tickets/${encoded}/ai-details?scope=phase&phase=CODING&phaseAttempt=0`)).status).toBe(400)
    expect((await app.request('/api/tickets/999%3AMISSING/ai-details?scope=lifecycle')).status).toBe(404)
  })
})
