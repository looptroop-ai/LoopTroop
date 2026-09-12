import { TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import type { TicketContext } from '../../machines/types'
import { existsSync } from 'fs'
import {
  getTicketContext as getStoredTicketContext,
  getTicketPaths,
  readTicketFile,
} from '../../storage/tickets'
import {
  buildStructuredOutputMetadata,
  type StructuredOutputMetadata,
} from '../../structuredOutput'

export function loadTicketDirContext(context: TicketContext) {
  const ticket = getStoredTicketContext(context.ticketId)
  const paths = getTicketPaths(context.ticketId)

  if (!ticket || !paths) {
    throw new TicketWorkspaceNotInitializedError(`Ticket workspace not initialized: missing ticket context for ${context.externalId}`)
  }

  const worktreePath = paths.worktreePath
  const ticketDir = paths.ticketDir

  if (!existsSync(ticketDir)) {
    throw new TicketWorkspaceNotInitializedError(`Ticket workspace not initialized: missing ticket directory for ${context.externalId}`)
  }

  const relevantFiles = readTicketFile(context.ticketId, 'relevant-files.yaml') ?? undefined

  return { worktreePath, ticket: ticket.localTicket, ticketDir, relevantFiles }
}

export function buildStructuredMetadata(
  base: Partial<StructuredOutputMetadata> | null | undefined,
  extra?: Partial<StructuredOutputMetadata>,
): StructuredOutputMetadata {
  return buildStructuredOutputMetadata(base, extra)
}
