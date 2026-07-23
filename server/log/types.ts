export type LogEventType = 'state_change' | 'model_output' | 'test_result' | 'error' | 'bead_complete' | 'info' | 'debug'

export type LogSource = 'system' | 'opencode' | 'error' | 'debug' | `model:${string}`
type LogAudience = 'all' | 'ai' | 'debug'
type LogEntryOperation = 'append' | 'upsert' | 'finalize'
export type LogKind = 'milestone' | 'reasoning' | 'text' | 'assistant' | 'tool' | 'step' | 'session' | 'prompt' | 'error' | 'test'
export type PromptTimeoutKind = 'ai_response' | 'council_response' | 'per_iteration' | 'execution_setup' | 'opencode_prompt'

export interface LogEvent {
  timestamp: string
  type: LogEventType
  ticketId: string
  phase: string
  phaseAttempt?: number
  message: string
  content?: string
  source?: LogSource
  status?: string
  data?: Record<string, unknown>
  entryId?: string
  fingerprint?: string
  op?: LogEntryOperation
  audience?: LogAudience
  kind?: LogKind
  modelId?: string
  variant?: string
  sessionId?: string
  beadId?: string
  beadIteration?: number
  timeoutMs?: number
  deadlineAt?: string
  timeoutKind?: PromptTimeoutKind
  streaming?: boolean
}
