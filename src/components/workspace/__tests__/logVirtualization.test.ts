import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useVirtualFirstItemIndex } from '../logVirtualization'

describe('useVirtualFirstItemIndex', () => {
  it('retains the logical index for tail appends and shifts only for prepends', () => {
    const { result, rerender } = renderHook(
      ({ keys, view }) => useVirtualFirstItemIndex(keys, 'row-a', view),
      { initialProps: { keys: ['delimiter', 'row-a', 'row-b'], view: 'all' } },
    )
    expect(result.current).toBe(1_000_000)

    rerender({ keys: ['delimiter', 'row-a', 'row-b', 'row-c'], view: 'all' })
    expect(result.current).toBe(1_000_000)

    rerender({ keys: ['older-delimiter', 'row-old', 'delimiter', 'row-a', 'row-b', 'row-c'], view: 'all' })
    expect(result.current).toBe(999_998)

    rerender({ keys: ['older-delimiter', 'row-old', 'delimiter', 'row-a'], view: 'system' })
    expect(result.current).toBe(1_000_000)
  })
})
