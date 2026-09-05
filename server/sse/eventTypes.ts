/**
 * Every event name the daemon broadcasts.
 *
 * A runtime array with the type derived from it, rather than a bare union: the
 * interface listens for these by name, so they are a wire contract, and a
 * contract that only exists as a type cannot be asserted on. The alternative
 * was scanning this file's source text from a test, which breaks the moment
 * anyone reformats the declaration.
 *
 * Adding a name here is the whole edit — `SSEEventType` follows.
 */
export const SSE_EVENT_TYPES = [
  'state_change',
  'log',
  'progress',
  'app_error',
  'bead_complete',
  'needs_input',
  'artifact_change',
  'ai_metrics',
] as const

export type SSEEventType = typeof SSE_EVENT_TYPES[number]

/**
 * Payloads are deliberately not typed here.
 *
 * `SSEBroadcaster.broadcast` takes `Record<string, unknown>` and every emitter
 * builds its object inline, so a per-event interface describes a contract
 * nothing checks. This file used to carry nine of them — one per event name —
 * and not one was imported anywhere; they drifted from the objects actually
 * sent without a single compiler complaint. Typing the boundary for real means
 * a discriminated union that `broadcast` accepts and every emitter narrows to,
 * which is a change to the emission path rather than a set of spare interfaces.
 */

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


