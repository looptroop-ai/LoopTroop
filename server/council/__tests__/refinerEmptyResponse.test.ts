import { describe, it, expect, vi } from 'vitest'

// The real prompt runner is needed here; other workflow suites replace it.
vi.unmock('../../workflow/runOpenCodePrompt')

import { MockOpenCodeAdapter } from '../../opencode/adapter'
import { refineDraft, EMPTY_REFINEMENT_RESPONSE_ERROR } from '../refiner'
import type { DraftResult } from '../types'

const winnerDraft: DraftResult = {
  memberId: 'model-a',
  content: 'winner draft content',
  outcome: 'completed',
  duration: 1,
}

function runRefine(
  adapter: MockOpenCodeAdapter,
  validateResponse?: (content: string) => { normalizedContent?: string },
  maxStructuredRetries = 1,
) {
  return refineDraft(
    adapter,
    winnerDraft,
    [],
    [{ type: 'text', content: 'refine prompt' }],
    '/tmp/test',
    300000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    validateResponse,
    'Return only YAML.',
    undefined,
    'default',
    maxStructuredRetries,
  )
}

describe('refineDraft treats an empty response as a validation failure', () => {
  it('retries instead of substituting the winner draft', async () => {
    const adapter = new MockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', '')
    adapter.mockResponses.set('mock-session-2', 'refined output')

    const result = await runRefine(adapter, (content) => ({ normalizedContent: content }))

    expect(result.content).toBe('refined output')
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: '', failureClass: 'empty_response' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: 'refined output' }),
    ])
  })

  it('fails with the empty-response error once the retries are exhausted', async () => {
    const adapter = new MockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', '')
    adapter.mockResponses.set('mock-session-2', '   ')

    await expect(runRefine(adapter, (content) => ({ normalizedContent: content })))
      .rejects.toThrow(EMPTY_REFINEMENT_RESPONSE_ERROR)
  })

  it('rejects an empty response even when the caller passes no validator', async () => {
    const adapter = new MockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', '')
    adapter.mockResponses.set('mock-session-2', 'refined output')

    const result = await runRefine(adapter)

    expect(result.content).toBe('refined output')
  })

  it('reports the empty response to the session log rather than the winner draft', async () => {
    const adapter = new MockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', '')
    adapter.mockResponses.set('mock-session-2', 'refined output')
    const logged: string[] = []

    await refineDraft(
      adapter,
      winnerDraft,
      [],
      [{ type: 'text', content: 'refine prompt' }],
      '/tmp/test',
      300000,
      undefined,
      (entry) => { logged.push(entry.response) },
    )

    expect(logged[0]).toBe('')
    expect(logged).not.toContain(winnerDraft.content)
  })
})
