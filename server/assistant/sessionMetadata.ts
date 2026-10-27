import { z } from 'zod'

export const ASSISTANT_SESSION_PREFIX = 'assistant.session.'
export const ASSISTANT_CLEANUP_PREFIX = 'assistant.cleanup.'

export const sessionRecordSchema = z.object({
  id: z.uuid(),
  mode: z.enum(['help', 'tickets']),
  ticketId: z.string().nullable(),
  projectId: z.number().int().positive().nullable(),
  title: z.string(),
  archived: z.boolean(),
  saved: z.boolean(),
  owner: z.string(),
  openCodeSessionId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const assistantCleanupReceiptSchema = z.object({
  id: z.uuid(),
  openCodeSessionId: z.string().min(1),
})

export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type AssistantCleanupReceipt = z.infer<typeof assistantCleanupReceiptSchema>

export function readSessionRecord(key: string, value: string): SessionRecord | undefined {
  try {
    const parsed = sessionRecordSchema.parse(JSON.parse(value))
    return key === ASSISTANT_SESSION_PREFIX + parsed.id ? parsed : undefined
  } catch {
    return undefined
  }
}

export function readAssistantCleanupReceipt(key: string, value: string): AssistantCleanupReceipt | undefined {
  try {
    const parsed = assistantCleanupReceiptSchema.parse(JSON.parse(value))
    return key === ASSISTANT_CLEANUP_PREFIX + parsed.id ? parsed : undefined
  } catch {
    return undefined
  }
}
