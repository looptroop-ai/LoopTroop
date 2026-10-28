export interface AssistantScope {
  ticketId?: string
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface AssistantSessionSummary {
  id: string
  ticketId: string | null
  title: string
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface AssistantSession extends AssistantSessionSummary {
  messages: AssistantMessage[]
  canResume: boolean
  saved: boolean
}

export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; session: AssistantSession }
  | { type: 'error'; error: string }
