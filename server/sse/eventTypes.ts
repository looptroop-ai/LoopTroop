export type SSEEventType = 'state_change' | 'log' | 'progress' | 'app_error' | 'bead_complete' | 'needs_input' | 'artifact_change' | 'ai_metrics'

export interface SSEEvent {
  id: string
  event: SSEEventType
  data: Record<string, unknown>
  ticketId: string
  timestamp: string
}

export interface StateChangeEvent {
  ticketId: string
  from: string
  to: string
  phaseAttempt?: number
  previousStatus?: string | null
}

export interface LogEvent {
  ticketId: string
  type: string
  content: string
  phase?: string
  phaseAttempt?: number
  status?: string
  source?: string
  entryId?: string
  op?: 'append' | 'upsert' | 'finalize'
  audience?: 'all' | 'ai' | 'debug'
  kind?: 'milestone' | 'reasoning' | 'text' | 'assistant' | 'tool' | 'step' | 'session' | 'prompt' | 'error' | 'test'
  modelId?: string
  sessionId?: string
  streaming?: boolean
  message?: string
  data?: Record<string, unknown>
}

export interface ProgressEvent {
  ticketId: string
  bead: number
  total: number
  percent: number
}

export interface ErrorEvent {
  ticketId: string
  message: string
  recoverable: boolean
}

export interface BeadCompleteEvent {
  ticketId: string
  beadId: string
  attempts: number
}

export interface NeedsInputEvent {
  ticketId: string
  type: string
  questionIndex?: number
  context?: Record<string, unknown>
}

export interface ArtifactSnapshot {
  id: number
  ticketId: string
  phase: string
  phaseAttempt: number
  artifactType: string
  filePath: string | null
  content: string | null
  createdAt: string
  updatedAt: string
}

/** Lightweight artifact metadata used by list responses and SSE replay. */
export interface ArtifactManifestEntry {
  id: number
  ticketId: string
  phase: string
  phaseAttempt: number
  artifactType: string
  createdAt: string
  updatedAt: string
  contentByteCount: number
  contentSha256: string
  available: boolean
  preview: Record<string, string | number | boolean | null>
}

export interface ArtifactChangeEvent {
  ticketId: string
  phase: string
  artifactType: string
  /** Metadata only: artifact bodies never enter the SSE replay buffer. */
  artifact?: ArtifactManifestEntry
  removedArtifactIds?: number[]
  invalidatedPhases?: string[]
}

export interface AiMetricsEvent {
  ticketId: string
  phase: string
  phaseAttempt: number
  modelId: string
  updatedAt: string
}
