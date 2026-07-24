import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index'
import { profiles } from '../db/schema'
import { eq } from 'drizzle-orm'
import { validateModelSelection } from '../opencode/modelValidation'
import { parseCouncilMembers } from '../council/members'
import { normalizeModelId } from '../../shared/modelId'

const profileRouter = new Hono()
const MAX_TIMEOUT_MS = 3_600_000

const profileSchema = z.object({
  gitHookPolicy: z.enum(['validate_explicitly', 'use_on_internal_commits', 'ignore_internal_only']).optional(),
  manualQaEnabled: z.boolean().optional(),
  mainImplementer: z.string().optional(),
  mainImplementerVariant: z.string().optional(),
  councilMembers: z.string().optional(),
  councilMemberVariants: z.string().optional(),
  minCouncilQuorum: z.number().int().min(1).max(6).optional(),
  perIterationTimeout: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional(), // 0 = no timeout
  executionSetupTimeout: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional(), // 0 = no timeout
  councilResponseTimeout: z.number().int().min(10_000).max(MAX_TIMEOUT_MS).optional(),
  interviewQuestions: z.number().int().min(0).max(50).optional(), // 0 is accepted, but normal runs should keep a positive interview budget
  coverageFollowUpBudgetPercent: z.number().int().min(0).max(100).optional(),
  maxCoveragePasses: z.number().int().min(1).max(10).optional(),
  maxPrdCoveragePasses: z.number().int().min(2).max(20).optional(),
  maxBeadsCoveragePasses: z.number().int().min(2).max(20).optional(),
  structuredRetryCount: z.number().int().min(0).max(5).optional(),
  maxIterations: z.number().int().min(0).max(20).optional(),
  opencodeRetryLimit: z.number().int().min(0).max(50).optional(),
  opencodeRetryDelay: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional(),
  opencodeSteps: z.number().int().min(0).max(500).optional(), // 0 = no limit (OpenCode default)
  toolInputMaxChars: z.number().int().min(500).max(50_000).optional(),
  toolOutputMaxChars: z.number().int().min(1_000).max(100_000).optional(),
  toolErrorMaxChars: z.number().int().min(500).max(50_000).optional(),
})

function normalizeModelSelection(
  mainImplementerRaw: string | null | undefined,
  councilMembersRaw: string | null | undefined,
) {
  const mainImplementer = normalizeModelId(mainImplementerRaw)
  const councilMembers = Array.from(new Set([
    mainImplementer,
    ...parseCouncilMembers(councilMembersRaw).map(normalizeModelId),
  ].filter(Boolean)))

  return {
    mainImplementer,
    councilMembers,
  }
}

function hasModelSelectionChange(
  existing: { mainImplementer: string | null; councilMembers: string | null },
  next: { mainImplementer: string | null | undefined; councilMembers: string | null | undefined },
) {
  const current = normalizeModelSelection(existing.mainImplementer, existing.councilMembers)
  const requested = normalizeModelSelection(next.mainImplementer, next.councilMembers)

  if (current.mainImplementer !== requested.mainImplementer) return true
  if (current.councilMembers.length !== requested.councilMembers.length) return true

  return current.councilMembers.some((memberId, index) => requested.councilMembers[index] !== memberId)
}

profileRouter.get('/profile', (c) => {
  const profile = db.select().from(profiles).limit(1).get()
  return c.json(profile ?? null)
})

profileRouter.post('/profile', async (c) => {
  const body = await c.req.json()
  const parsed = profileSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
  }
  let validatedModels
  try {
    validatedModels = await validateModelSelection(parsed.data.mainImplementer, parsed.data.councilMembers)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid model configuration' }, 400)
  }
  const existing = db.select().from(profiles).limit(1).get()
  if (existing) {
    return c.json({ error: 'Profile already exists. Use PATCH to update.' }, 409)
  }
  const result = db.insert(profiles).values({
    ...parsed.data,
    mainImplementer: validatedModels.mainImplementer,
    councilMembers: JSON.stringify(validatedModels.councilMembers),
  }).returning().get()
  return c.json(result, 201)
})

profileRouter.patch('/profile', async (c) => {
  const body = await c.req.json()
  const parsed = profileSchema.partial().safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
  }
  const existing = db.select().from(profiles).limit(1).get()
  if (!existing) {
    return c.json({ error: 'No profile found' }, 404)
  }

  const requestedMainImplementer = parsed.data.mainImplementer ?? existing.mainImplementer
  const requestedCouncilMembers = parsed.data.councilMembers ?? existing.councilMembers
  let modelPatch: Pick<typeof existing, 'mainImplementer' | 'councilMembers'>

  if (hasModelSelectionChange(existing, {
    mainImplementer: requestedMainImplementer,
    councilMembers: requestedCouncilMembers,
  })) {
    let validatedModels
    try {
      validatedModels = await validateModelSelection(requestedMainImplementer, requestedCouncilMembers)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid model configuration' }, 400)
    }

    modelPatch = {
      mainImplementer: validatedModels.mainImplementer,
      councilMembers: JSON.stringify(validatedModels.councilMembers),
    }
  } else {
    const normalizedRequested = normalizeModelSelection(requestedMainImplementer, requestedCouncilMembers)
    modelPatch = {
      mainImplementer: normalizedRequested.mainImplementer || existing.mainImplementer,
      councilMembers: JSON.stringify(normalizedRequested.councilMembers),
    }
  }

  const result = db.update(profiles)
    .set({
      ...parsed.data,
      ...modelPatch,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(profiles.id, existing.id))
    .returning()
    .get()
  return c.json(result)
})

export { profileRouter }
