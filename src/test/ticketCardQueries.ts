/**
 * The kanban card's open control is named after what the card shows: the ticket
 * title first, then the id, then the wait it is under, if any. Tests match the
 * stable tail rather than the whole string so a fixture's title can change without
 * touching every assertion.
 */
export function ticketCardLabel(externalId: string, waitLabel?: string) {
  const suffix = `, open ticket ${externalId}${waitLabel ? `, ${waitLabel}` : ''}`
  return (content: string) => content.endsWith(suffix)
}

/** Matches any card's open control, for tests that collect all of them. */
export const ANY_TICKET_CARD_LABEL = /, open ticket /
