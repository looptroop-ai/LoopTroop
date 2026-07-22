import { and, desc, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { phaseArtifacts, ticketPhaseAttempts } from '../db/schema'
import { broadcaster } from '../sse/broadcaster'
import type { ArtifactManifestEntry, ArtifactSnapshot } from '../sse/eventTypes'
import { getTicketContext } from './ticketQueries'
import { assertCurrentEditablePhaseAttempt, resolvePhaseAttempt } from './ticketPhaseAttempts'

type LocalPhaseArtifactRow = typeof phaseArtifacts.$inferSelect

export type PublicPhaseArtifactRow = ArtifactSnapshot
export type PublicArtifactManifestEntry = ArtifactManifestEntry

const UNKNOWN_ARTIFACT_TYPE = 'UNKNOWN'

function toPublicPhaseArtifact(ticketRef: string, artifact: LocalPhaseArtifactRow): PublicPhaseArtifactRow {
  return {
    id: artifact.id,
    ticketId: ticketRef,
    phase: artifact.phase,
    phaseAttempt: artifact.phaseAttempt ?? 1,
    artifactType: artifact.artifactType ?? UNKNOWN_ARTIFACT_TYPE,
    filePath: null,
    content: artifact.content,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

function compactPreview(content: string): Record<string, string | number | boolean | null> {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const preview: Record<string, string | number | boolean | null> = {}
    for (const key of ['title', 'name', 'memberId', 'member_id', 'modelId', 'model_id', 'outcome', 'status', 'winnerId', 'winner_id']) {
      const value = record[key]
      if (typeof value === 'string') preview[key] = value.slice(0, 300)
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) preview[key] = value
    }
    return preview
  } catch {
    return {}
  }
}

export function toArtifactManifestEntry(ticketRef: string, artifact: LocalPhaseArtifactRow): PublicArtifactManifestEntry {
  return {
    id: artifact.id,
    ticketId: ticketRef,
    phase: artifact.phase,
    phaseAttempt: artifact.phaseAttempt ?? 1,
    artifactType: artifact.artifactType ?? UNKNOWN_ARTIFACT_TYPE,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    contentByteCount: Buffer.byteLength(artifact.content, 'utf8'),
    contentSha256: createHash('sha256').update(artifact.content).digest('hex'),
    available: true,
    preview: compactPreview(artifact.content),
  }
}

function broadcastArtifactChange(
  ticketRef: string,
  phase: string,
  artifactType: string,
  artifact: LocalPhaseArtifactRow,
) {
  broadcaster.broadcast(ticketRef, 'artifact_change', {
    ticketId: ticketRef,
    phase,
    artifactType,
    artifact: toArtifactManifestEntry(ticketRef, artifact),
  })
}

export function listPhaseArtifacts(
  ticketRef: string,
  options?: {
    phase?: string
    phaseAttempt?: number
  },
): PublicPhaseArtifactRow[] {
  const context = getTicketContext(ticketRef)
  if (!context) return []
  return selectVisibleArtifacts(ticketRef, options).map((artifact) => toPublicPhaseArtifact(ticketRef, artifact))
}

function selectVisibleArtifacts(
  ticketRef: string,
  options?: { phase?: string; phaseAttempt?: number },
): LocalPhaseArtifactRow[] {
  const context = getTicketContext(ticketRef)
  if (!context) return []
  const conditions = [eq(phaseArtifacts.ticketId, context.localTicketId)]
  if (options?.phase) {
    conditions.push(eq(phaseArtifacts.phase, options.phase))
    conditions.push(eq(phaseArtifacts.phaseAttempt, resolvePhaseAttempt(ticketRef, options.phase, options.phaseAttempt)))
    return context.projectDb.select().from(phaseArtifacts).where(and(...conditions)).all()
  }

  const artifacts = context.projectDb.select().from(phaseArtifacts)
    .where(eq(phaseArtifacts.ticketId, context.localTicketId)).all()
  const activeAttempts = new Map<string, number>()
  for (const attempt of context.projectDb.select().from(ticketPhaseAttempts)
    .where(eq(ticketPhaseAttempts.ticketId, context.localTicketId)).all()) {
    if (attempt.state === 'active') activeAttempts.set(attempt.phase, attempt.attemptNumber)
  }
  // Untracked phases do not have an attempt row and always use attempt one.
  for (const artifact of artifacts) {
    if (!activeAttempts.has(artifact.phase)) activeAttempts.set(artifact.phase, 1)
  }
  return artifacts.filter((artifact) => artifact.phaseAttempt === activeAttempts.get(artifact.phase))
}

/** Lists lightweight metadata. Bodies are deliberately excluded from this API shape. */
export function listArtifactManifest(ticketRef: string, options?: { phase?: string; phaseAttempt?: number }): PublicArtifactManifestEntry[] {
  return selectVisibleArtifacts(ticketRef, options).map((artifact) => toArtifactManifestEntry(ticketRef, artifact))
}

export function getPhaseArtifactById(ticketRef: string, artifactId: number): LocalPhaseArtifactRow | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined
  return context.projectDb.select().from(phaseArtifacts).where(and(
    eq(phaseArtifacts.ticketId, context.localTicketId),
    eq(phaseArtifacts.id, artifactId),
  )).get()
}

export function getLatestPhaseArtifact(
  ticketRef: string,
  artifactType: string,
  phase?: string,
  phaseAttempt?: number,
): LocalPhaseArtifactRow | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined
  const conditions = [
    eq(phaseArtifacts.ticketId, context.localTicketId),
    eq(phaseArtifacts.artifactType, artifactType),
  ]
  if (phase) {
    conditions.push(eq(phaseArtifacts.phase, phase))
    conditions.push(eq(phaseArtifacts.phaseAttempt, resolvePhaseAttempt(ticketRef, phase, phaseAttempt)))
  }
  return context.projectDb.select().from(phaseArtifacts).where(and(...conditions)).orderBy(desc(phaseArtifacts.id)).get()
}

export function countPhaseArtifacts(ticketRef: string, artifactType: string, phase?: string, phaseAttempt?: number): number {
  const context = getTicketContext(ticketRef)
  if (!context) return 0

  const conditions = [
    eq(phaseArtifacts.ticketId, context.localTicketId),
    eq(phaseArtifacts.artifactType, artifactType),
  ]
  if (phase) {
    conditions.push(eq(phaseArtifacts.phase, phase))
    conditions.push(eq(phaseArtifacts.phaseAttempt, resolvePhaseAttempt(ticketRef, phase, phaseAttempt)))
  }

  const rows = context.projectDb.select({ id: phaseArtifacts.id })
    .from(phaseArtifacts)
    .where(and(...conditions))
    .all()
  return rows.length
}

export function insertPhaseArtifact(ticketRef: string, artifact: Omit<typeof phaseArtifacts.$inferInsert, 'ticketId'>): void {
  const context = getTicketContext(ticketRef)
  if (!context) throw new Error(`Ticket not found: ${ticketRef}`)
  assertCurrentEditablePhaseAttempt({
    ticketId: ticketRef,
    phase: artifact.phase,
    requestedPhaseAttempt: artifact.phaseAttempt,
  })
  const phaseAttempt = resolvePhaseAttempt(ticketRef, artifact.phase, artifact.phaseAttempt)
  const timestamp = new Date().toISOString()
  const inserted = context.projectDb.insert(phaseArtifacts).values({
    ...artifact,
    ticketId: context.localTicketId,
    phaseAttempt,
    updatedAt: artifact.updatedAt ?? timestamp,
  }).returning().get()
  broadcastArtifactChange(ticketRef, artifact.phase, artifact.artifactType ?? UNKNOWN_ARTIFACT_TYPE, inserted)
}

export function upsertLatestPhaseArtifact(
  ticketRef: string,
  artifactType: string,
  phase: string,
  content: string,
  phaseAttempt?: number,
): void {
  const context = getTicketContext(ticketRef)
  if (!context) throw new Error(`Ticket not found: ${ticketRef}`)
  assertCurrentEditablePhaseAttempt({
    ticketId: ticketRef,
    phase,
    requestedPhaseAttempt: phaseAttempt,
  })
  const resolvedPhaseAttempt = resolvePhaseAttempt(ticketRef, phase, phaseAttempt)
  const updatedAt = new Date().toISOString()
  const existing = context.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, context.localTicketId),
      eq(phaseArtifacts.artifactType, artifactType),
      eq(phaseArtifacts.phase, phase),
      eq(phaseArtifacts.phaseAttempt, resolvedPhaseAttempt),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()
  if (existing) {
    context.projectDb.update(phaseArtifacts)
      .set({ content, updatedAt })
      .where(eq(phaseArtifacts.id, existing.id))
      .run()
    broadcastArtifactChange(ticketRef, phase, artifactType, {
      ...existing,
      content,
      updatedAt,
    })
    return
  }
  const inserted = context.projectDb.insert(phaseArtifacts).values({
    ticketId: context.localTicketId,
    phase,
    phaseAttempt: resolvedPhaseAttempt,
    artifactType,
    content,
    createdAt: updatedAt,
    updatedAt,
  }).returning().get()
  broadcastArtifactChange(ticketRef, phase, artifactType, inserted)
}
