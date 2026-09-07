import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAttentionAck, type AttentionScope } from '../useAttentionAck'

interface Props {
  ticketId: string | undefined
  signature: string | null
  seenSignature: string | null | undefined
  retryKey: string | number | undefined
}

function setup(initial: Props, scope: AttentionScope = 'error_attention') {
  const mark = vi.fn()
  const clear = vi.fn()
  const saveUiState = vi.fn()
  const { rerender } = renderHook(
    (props: Props) => useAttentionAck({ ...props, scope, mark, clear, saveUiState }),
    { initialProps: initial },
  )
  return { mark, clear, saveUiState, rerender }
}

describe('useAttentionAck', () => {
  it('records an unacknowledged signal locally and on the server', () => {
    const { mark, saveUiState } = setup({
      ticketId: 'p1:LT-1',
      signature: 'error:3',
      seenSignature: null,
      retryKey: 1,
    })

    expect(mark).toHaveBeenCalledWith('p1:LT-1', 'error:3')
    expect(saveUiState).toHaveBeenCalledWith({
      ticketId: 'p1:LT-1',
      scope: 'error_attention',
      data: { seenSignature: 'error:3' },
    })
  })

  it('does not re-save a signal the server already holds', () => {
    const { mark, saveUiState } = setup({
      ticketId: 'p1:LT-1',
      signature: 'error:3',
      seenSignature: 'error:3',
      retryKey: 1,
    })

    // Local marking is idempotent and cheap; the request is not.
    expect(mark).toHaveBeenCalledWith('p1:LT-1', 'error:3')
    expect(saveUiState).not.toHaveBeenCalled()
  })

  /**
   * The retry the hook exists to allow. A save that never landed leaves the
   * server holding the old value, and nothing in the compared inputs changes —
   * so without a key that moves on every read, the acknowledgment is lost for
   * every other tab and every later session.
   */
  it('retries the save when the ticket is re-read', () => {
    const { saveUiState, rerender } = setup({
      ticketId: 'p1:LT-1',
      signature: 'error:3',
      seenSignature: null,
      retryKey: 1000,
    })

    expect(saveUiState).toHaveBeenCalledTimes(1)

    // Same signal, same unacknowledged server value: a later fetch of an
    // unchanged ticket. The record's own `updatedAt` would not have moved here.
    rerender({ ticketId: 'p1:LT-1', signature: 'error:3', seenSignature: null, retryKey: 2000 })

    expect(saveUiState).toHaveBeenCalledTimes(2)
  })

  it('clears a signal the server still holds', () => {
    const { clear, saveUiState } = setup({
      ticketId: 'p1:LT-1',
      signature: null,
      seenSignature: 'error:3',
      retryKey: 1,
    })

    expect(clear).toHaveBeenCalledWith('p1:LT-1')
    expect(saveUiState).toHaveBeenCalledWith({
      ticketId: 'p1:LT-1',
      scope: 'error_attention',
      data: { seenSignature: null },
    })
  })

  /**
   * Neither `null` nor a missing field can change in response to writing
   * `null`, so a hook that wrote one would write it again on the next read, and
   * the one after that — a request per poll, for the whole time a quiet ticket
   * is open, recording nothing.
   */
  it.each([
    ['already null', null],
    ['absent from the payload', undefined],
  ])('writes nothing to clear a signal the server does not hold (%s)', (_label, seenSignature) => {
    const { clear, saveUiState, rerender } = setup({
      ticketId: 'p1:LT-1',
      signature: null,
      seenSignature,
      retryKey: 1000,
    })

    expect(clear).toHaveBeenCalledWith('p1:LT-1')
    expect(saveUiState).not.toHaveBeenCalled()

    rerender({ ticketId: 'p1:LT-1', signature: null, seenSignature, retryKey: 2000 })

    expect(saveUiState).not.toHaveBeenCalled()
  })

  it('does nothing at all until the ticket has loaded', () => {
    const { mark, clear, saveUiState } = setup({
      ticketId: undefined,
      signature: null,
      seenSignature: undefined,
      retryKey: undefined,
    })

    expect(mark).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(saveUiState).not.toHaveBeenCalled()
  })
})
