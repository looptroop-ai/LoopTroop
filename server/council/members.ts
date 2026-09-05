import { parseLockedCouncilMembers } from '../storage/ticketQueries'

/**
 * Reads a stored council-member list.
 *
 * Delegates to the locking path's parser rather than keeping a second one. The
 * two disagreed: this used to drop non-string entries and keep the rest, while
 * the lock validated the whole array and returned nothing on any bad element —
 * so a profile could persist members that vanished the moment a ticket started,
 * and the operator was told nothing.
 */
export function parseCouncilMembers(raw: string | null | undefined): string[] {
  return parseLockedCouncilMembers(raw)
}

