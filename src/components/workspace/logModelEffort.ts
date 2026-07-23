import type { Ticket } from '@/hooks/useTickets'

export function resolveLogModelEffort(
  ticket: Ticket | undefined,
  modelId: string,
  observedEffort?: string,
): string | null {
  if (ticket?.lockedMainImplementer === modelId) {
    return ticket.lockedMainImplementerVariant?.trim() || null
  }

  if (ticket?.lockedCouncilMembers?.includes(modelId)) {
    return ticket.lockedCouncilMemberVariants?.[modelId]?.trim() || null
  }

  return observedEffort?.trim() || 'Not reported'
}

export function formatLogModelEffort(effort: string | null): string {
  return effort ?? 'None (provider default)'
}
