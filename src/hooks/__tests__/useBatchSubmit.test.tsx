import type { ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { useBatchSubmit } from '../useBatchSubmit'

/**
 * The cross-ticket surfaces are covered end-to-end in `src/__tests__/ticketSwitchIsolation.test.tsx`
 * by remounting the dashboard per ticket. These tests are the half a remount cannot prove: the
 * restore gate, and what the hook does when its `ticketId` changes underneath it. Both have to hold
 * on their own, because they are the last line of defence if the remount is ever removed.
 */

const SCOPE = 'interview-drafts'
const BATCH_KEY = 'prom4:0:1'

function makeUiStatePayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    exists: true,
    data: null,
    updatedAt: '2026-08-30T10:00:00.000Z',
    revision: 3,
    clientRevision: null,
    ...overrides,
  }
}

function renderBatchSubmit(ticketId: string, queryClient: QueryClient) {
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return renderHook(({ id }: { id: string }) => useBatchSubmit(id), {
    wrapper,
    initialProps: { id: ticketId },
  })
}

function uiStatePuts(fetchSpy: { mock: { calls: unknown[][] } }) {
  return fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')
}

let queryClient: QueryClient

beforeEach(() => {
  queryClient = createTestQueryClient()
})

afterEach(() => {
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('useBatchSubmit draft restore', () => {
  it('restores nothing when the payload belongs to another ticket, and leaves autosave off', async () => {
    // A payload for ticket A sitting under ticket B's query key, with B's own request still in
    // flight — which is precisely the window the gate exists for. It cannot come from
    // `fetchTicketUIState`, which stamps the id it requested; it is what a future change that
    // reuses data across keys (`placeholderData`, a shared cache entry) would hand the hook.
    queryClient.setQueryData(['ticket-ui-state', '1:T-B', SCOPE], makeUiStatePayload({
      ticketId: '1:T-A',
      data: { draftAnswers: { [BATCH_KEY]: { q1: "ticket A's answer" } }, skippedQuestions: {}, selectedOptions: {} },
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if ((init as RequestInit | undefined)?.method === 'PUT') {
        return createJsonResponse({ success: true, conflict: false, scope: SCOPE, updatedAt: null, revision: 4, clientRevision: 3 })
      }
      if (String(input).includes('/ui-state')) return new Promise<Response>(() => {})
      throw new Error(`Unhandled fetch: ${String(input)}`)
    })

    const { result } = renderBatchSubmit('1:T-B', queryClient)

    // Waiting out the restore frame: the restore runs in a `requestAnimationFrame`, so an immediate
    // assertion would pass even if the gate were missing.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    expect(result.current.draftAnswers).toEqual({})
    // Failing closed is the deliberate half: an unidentifiable payload leaves autosave off rather
    // than letting it overwrite whatever is on disk for this ticket.
    expect(result.current.autosaveState).toBe('pending')

    act(() => {
      result.current.handleBatchAnswer(BATCH_KEY, 'q1', 'typed on B')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    expect(uiStatePuts(fetchSpy)).toHaveLength(0)
  })

  it('keeps an answer typed before the saved drafts arrive, and then saves it', async () => {
    // The window between opening a ticket and its ui-state resolving is real typing time. An
    // unconditional assignment of the persisted collections would wipe it.
    let releaseUiState: (() => void) | null = null
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if ((init as RequestInit | undefined)?.method === 'PUT') {
        return createJsonResponse({ success: true, conflict: false, scope: SCOPE, updatedAt: null, revision: 4, clientRevision: 3 })
      }
      if (url.includes('/ui-state')) {
        return new Promise((resolve) => {
          releaseUiState = () => resolve(new Response(
            JSON.stringify(makeUiStatePayload({ exists: false, data: null })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ))
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { result } = renderBatchSubmit('1:T-early', queryClient)

    await waitFor(() => expect(releaseUiState).not.toBeNull())
    act(() => {
      result.current.handleBatchAnswer(BATCH_KEY, 'q1', 'typed while loading')
    })
    expect(result.current.draftAnswers).toEqual({ [BATCH_KEY]: { q1: 'typed while loading' } })

    await act(async () => {
      releaseUiState?.()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    expect(result.current.draftAnswers).toEqual({ [BATCH_KEY]: { q1: 'typed while loading' } })

    // And it is treated as unsaved, not as the restored baseline, so the debounce stores it.
    await waitFor(() => {
      const puts = uiStatePuts(fetchSpy)
      expect(puts).toHaveLength(1)
      expect(String(puts[0]?.[1] && (puts[0][1] as RequestInit).body)).toContain('typed while loading')
    }, { timeout: 2000 })
  })

  it('empties the in-memory draft maps when the ticket changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse(makeUiStatePayload({ exists: false, data: null })))

    const { result, rerender } = renderBatchSubmit('1:T-A', queryClient)

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    act(() => {
      result.current.handleBatchAnswer(BATCH_KEY, 'q1', "ticket A's answer")
      result.current.handleSkipQuestion(BATCH_KEY, 'q2')
      result.current.handleSkipReasonChange(BATCH_KEY, 'q2', 'not applicable to A')
      result.current.handleOptionToggle(BATCH_KEY, 'q3', 'opt-1', true)
    })
    expect(result.current.draftAnswers[BATCH_KEY]?.q1).toBe("ticket A's answer")

    rerender({ id: '1:T-B' })

    // The batch key carries no ticket id, so two tickets at the same interview position share it.
    // `handleSubmitBatch` posts these maps directly, without waiting for a restore — anything left
    // here would be submitted as the new ticket's answers.
    expect(result.current.draftAnswers).toEqual({})
    expect(result.current.skippedQuestions).toEqual({})
    expect(result.current.batchSelectedOptions).toEqual({})
    expect(result.current.batchSkipReasons).toEqual({})
  })

  it('flushes a draft that is still inside the debounce when the ticket is left', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse(makeUiStatePayload({ exists: false, data: null })))

    const { result, unmount } = renderBatchSubmit('1:T-flush', queryClient)

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    await waitFor(() => expect(result.current.autosaveState).toBe('saved'))

    act(() => {
      result.current.handleBatchAnswer(BATCH_KEY, 'q1', 'typed just before switching')
    })

    // Well inside the 350ms debounce: nothing has been written yet.
    expect(uiStatePuts(fetchSpy)).toHaveLength(0)

    unmount()

    const puts = uiStatePuts(fetchSpy)
    expect(puts).toHaveLength(1)
    expect(String(puts[0]?.[0])).toBe(`/api/tickets/${encodeURIComponent('1:T-flush')}/ui-state`)
    expect(String(puts[0]?.[1] && (puts[0][1] as RequestInit).body)).toContain('typed just before switching')
  })
})
