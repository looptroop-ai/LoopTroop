import type { TicketContext } from '../../machines/types'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  getTicketContext as getStoredTicketContext,
  getTicketPaths,
} from '../../storage/tickets'
import {
  buildStructuredOutputMetadata,
  type StructuredOutputMetadata,
} from '../../structuredOutput'

export function loadTicketDirContext(context: TicketContext) {
  const ticket = getStoredTicketContext(context.ticketId)
  const paths = getTicketPaths(context.ticketId)

  if (!ticket || !paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket context for ${context.externalId}`)
  }

  const worktreePath = paths.worktreePath
  const ticketDir = paths.ticketDir

  if (!existsSync(ticketDir)) {
    throw new Error(`Ticket workspace not initialized: missing ticket directory for ${context.externalId}`)
  }

  const relevantFilesPath = resolve(ticketDir, 'relevant-files.yaml')
  let relevantFiles: string | undefined
  if (existsSync(relevantFilesPath)) {
    try { relevantFiles = readFileSync(relevantFilesPath, 'utf-8') } catch { /* ignore */ }
  }

  return { worktreePath, ticket: ticket.localTicket, ticketDir, relevantFiles }
}

export function buildStructuredMetadata(
  base: Partial<StructuredOutputMetadata> | null | undefined,
  extra?: Partial<StructuredOutputMetadata>,
): StructuredOutputMetadata {
  return buildStructuredOutputMetadata(base, extra)
}
