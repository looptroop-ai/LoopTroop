import { eq, like } from 'drizzle-orm'
import { db } from '../db'
import { appMeta } from '../db/schema'
import {
  ASSISTANT_CLEANUP_PREFIX,
  ASSISTANT_SESSION_PREFIX,
  type AssistantCleanupReceipt,
  readAssistantCleanupReceipt,
  readSessionRecord,
} from './sessionMetadata'

export type AssistantSessionCleanupFilter = { ticketId: string } | { projectId: number }

let scheduleCleanup: ((receipts: readonly AssistantCleanupReceipt[]) => void) | undefined

export function setAssistantSessionCleanupScheduler(
  schedule: (receipts: readonly AssistantCleanupReceipt[]) => void,
): void {
  scheduleCleanup = schedule
}

export function queueAssistantSessionCleanup(filter: AssistantSessionCleanupFilter): void {
  const receipts = db.transaction(tx => {
    const rows = tx.select().from(appMeta).where(like(appMeta.key, `${ASSISTANT_SESSION_PREFIX}%`)).all()
    const queued: AssistantCleanupReceipt[] = []

    for (const row of rows) {
      const record = readSessionRecord(row.key, row.value)
      if (!record || record.mode !== 'tickets') continue
      if ('ticketId' in filter ? record.ticketId !== filter.ticketId : record.projectId !== filter.projectId) continue

      const receipt: AssistantCleanupReceipt = { id: record.id, openCodeSessionId: record.openCodeSessionId }
      tx.insert(appMeta).values({
        key: ASSISTANT_CLEANUP_PREFIX + receipt.id,
        value: JSON.stringify(receipt),
      }).onConflictDoNothing().run()
      tx.delete(appMeta).where(eq(appMeta.key, row.key)).run()
      queued.push(receipt)
    }

    return queued
  })

  if (receipts.length) scheduleCleanup?.(receipts)
}

export function queueAssistantSessionCleanupReceipt(receipt: AssistantCleanupReceipt): void {
  db.insert(appMeta).values({
    key: ASSISTANT_CLEANUP_PREFIX + receipt.id,
    value: JSON.stringify(receipt),
  }).onConflictDoNothing().run()
  scheduleCleanup?.([receipt])
}

export function listAssistantSessionCleanupReceipts(): AssistantCleanupReceipt[] {
  return db.select().from(appMeta).where(like(appMeta.key, `${ASSISTANT_CLEANUP_PREFIX}%`)).all()
    .flatMap(row => {
      const receipt = readAssistantCleanupReceipt(row.key, row.value)
      return receipt ? [receipt] : []
    })
}

export function deleteAssistantSessionCleanupReceipt(id: string): void {
  db.delete(appMeta).where(eq(appMeta.key, ASSISTANT_CLEANUP_PREFIX + id)).run()
}
