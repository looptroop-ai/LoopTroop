import { createTicket as createTicketRecord } from '../storage/tickets'

export interface CreateTicketOptions {
  projectId: number
  title: string
  description?: string
  priority?: number
  manualQaOverride?: boolean | null
  gitHookPolicy?: 'observe_only' | 'validate_advisory' | 'validate_required' | 'use_native_hooks' | null
}

export function createTicket(options: CreateTicketOptions) {
  return createTicketRecord(options)
}
