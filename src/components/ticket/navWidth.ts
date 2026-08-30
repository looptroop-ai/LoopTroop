/**
 * The navigator width is chrome, not ticket state: the dashboard is remounted per ticket so every
 * per-ticket buffer is rebuilt, and a width kept in component state alone would snap back to the
 * default on each switch. Stored locally because it describes this browser's window, not the
 * ticket — it should not follow the operator to another screen. Reads and writes are guarded; a
 * private window or blocked site data throws on access rather than returning empty.
 *
 * The bounds live here rather than in either component because both need them: `ResizeHandle`
 * clamps the live drag and `TicketDashboard` clamps what it stores and restores. Two copies would
 * drift, and then a stored width would fight the drag limit.
 */
export const NAV_WIDTH_STORAGE_KEY = 'looptroop-ticket-nav-width'
export const NAV_WIDTH_DEFAULT = 280
export const NAV_WIDTH_MIN = 200
export const NAV_WIDTH_VIEWPORT_FRACTION = 0.5

export function clampNavWidth(width: number): number {
  const viewportMax = typeof window === 'undefined'
    ? Number.POSITIVE_INFINITY
    : window.innerWidth * NAV_WIDTH_VIEWPORT_FRACTION
  return Math.max(NAV_WIDTH_MIN, Math.min(width, viewportMax))
}

export function readNavWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(NAV_WIDTH_STORAGE_KEY))
    // Every return goes through the clamp, including the default: a window narrow enough to make
    // 280px more than half the viewport should not get 280px just because nothing was stored.
    if (!Number.isFinite(stored) || stored <= 0) return clampNavWidth(NAV_WIDTH_DEFAULT)
    return clampNavWidth(stored)
  } catch {
    return clampNavWidth(NAV_WIDTH_DEFAULT)
  }
}

export function writeNavWidth(width: number): void {
  try {
    window.localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(Math.round(clampNavWidth(width))))
  } catch {
    // A preference that cannot be remembered is not worth failing a drag for.
  }
}
