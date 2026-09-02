/**
 * Builders for the API paths that carry an identifier.
 *
 * Ticket ids come from the project's own issue tracker, so they are whatever a
 * person typed: `FEAT/123`, `a b`, `100%`. Interpolated straight into a template
 * literal a slash silently changes which route matches and a `?` truncates the
 * path, so a fetch for one ticket answers about another or 404s for no visible
 * reason. Half the call sites already encoded and half did not, which is the
 * failure mode a hand-maintained list of "the ones that need it" always reaches.
 *
 * Every segment goes through `encodeURIComponent` here, so a new caller cannot
 * forget. Query strings are the caller's: append `?${params}` to the result.
 */

function encodeSegments(segments: ReadonlyArray<string | number>): string {
  return segments.map((segment) => encodeURIComponent(String(segment))).join('/')
}

/** `/api/tickets/<ticketId>[/<segment>…]`, every segment encoded. */
export function apiTicketPath(ticketId: string, ...segments: Array<string | number>): string {
  const tail = segments.length > 0 ? `/${encodeSegments(segments)}` : ''
  return `/api/tickets/${encodeURIComponent(ticketId)}${tail}`
}

/** `/api/projects/<projectId>[/<segment>…]`, every segment encoded. */
export function apiProjectPath(projectId: string | number, ...segments: Array<string | number>): string {
  const tail = segments.length > 0 ? `/${encodeSegments(segments)}` : ''
  return `/api/projects/${encodeURIComponent(String(projectId))}${tail}`
}
