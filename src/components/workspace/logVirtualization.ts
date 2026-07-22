import { useRef } from 'react'

const INITIAL_FIRST_ITEM_INDEX = 1_000_000

/**
 * Keeps Virtuoso's logical first index stable for tail appends and moves it
 * only when rows were inserted before the previous anchor.
 */
export function useVirtualFirstItemIndex(
  itemKeys: string[],
  anchorKey: string | undefined,
  viewKey: string,
): number {
  const state = useRef({ viewKey, anchorKey, anchorPosition: anchorKey ? itemKeys.indexOf(anchorKey) : 0, firstItemIndex: INITIAL_FIRST_ITEM_INDEX })
  const current = state.current

  if (current.viewKey !== viewKey || !current.anchorKey || !itemKeys.includes(current.anchorKey)) {
    state.current = {
      viewKey,
      anchorKey,
      anchorPosition: anchorKey ? itemKeys.indexOf(anchorKey) : 0,
      firstItemIndex: INITIAL_FIRST_ITEM_INDEX,
    }
    return INITIAL_FIRST_ITEM_INDEX
  }

  const nextAnchorPosition = itemKeys.indexOf(current.anchorKey)
  const prependedCount = Math.max(0, nextAnchorPosition - current.anchorPosition)
  if (prependedCount > 0) current.firstItemIndex -= prependedCount
  current.anchorPosition = nextAnchorPosition
  return current.firstItemIndex
}
