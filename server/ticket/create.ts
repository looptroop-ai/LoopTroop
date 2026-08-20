import { createTicket as createTicketRecord } from '../storage/tickets'

export interface CreateTicketOptions {
  projectId: number
  title: string
  description?: string
  priority?: number
  manualQaOverride?: boolean | null
}

export function createTicket(options: CreateTicketOptions) {
  return createTicketRecord(options)
}
