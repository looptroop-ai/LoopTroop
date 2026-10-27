import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index'
import { profiles } from '../db/schema'
import { eq } from 'drizzle-orm'
import { validateConfiguredModel, validateModelSelection } from '../opencode/modelValidation'
import { parseCouncilMembers } from '../council/members'
import {
  needsOpenRouterRoutingConfig,
  openRouterRoutingModelsWouldChangeConfig,
  registerOpenRouterRoutingModels,
} from '../opencode/openRouterRoutingConfig'
import { withProviderCatalogReload } from '../opencode/providerCatalog'
import { ProviderCatalogBusyError } from '../opencode/providerCatalogReload'
import { getOpenCodeConnection } from '../opencode/connection'
import { getOpenCodeBaseUrl } from '../opencode/runtimeConfig'
import { aiQuestionWindowSchema, gitHookPolicySchema, ignoreModeSchema } from '../lib/settingSchemas'

const profileRouter = new Hono()
const MAX_TIMEOUT_MS = 3_600_000

const profileSchema = z.object({
  gitHookPolicy: gitHookPolicySchema.optional(),
  ignoreMode: ignoreModeSchema.optional(),
  manualQaEnabled: z.boolean().optional(),
  aiQuestionsEnabled: z.boolean().optional(),
  aiQuestionWindow: aiQuestionWindowSchema.optional(),
  mainImplementer: z.string().optional(),
  mainImplementerVariant: z.string().optional(),
  chatModel: z.string().trim().min(1).nullable().optional(),
  chatModelVariant: z.string().trim().min(1).nullable().optional(),
  saveChatSessions: z.boolean().optional(),
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
  const mainImplementer = typeof mainImplementerRaw === 'string' ? mainImplementerRaw.trim() : ''
  const councilMembers = Array.from(new Set([
    mainImplementer,
    ...parseCouncilMembers(councilMembersRaw),
  ].filter(Boolean)))

  return {
    mainImplementer,
    councilMembers,
  }
}

async function registerSelectedRoutingModels(modelIds: readonly string[]): Promise<void> {
  if (!needsOpenRouterRoutingConfig(modelIds)) return
  const connection = await getOpenCodeConnection(getOpenCodeBaseUrl())
  if (!openRouterRoutingModelsWouldChangeConfig(modelIds, connection.protocol)) return
  await withProviderCatalogReload(async (connection, refresh) => {
    if (!openRouterRoutingModelsWouldChangeConfig(modelIds, connection.protocol)) return
    if (registerOpenRouterRoutingModels(modelIds, connection.protocol)) await refresh()
  })
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
  let chatModel: string | null = null
  try {
    validatedModels = await validateModelSelection(parsed.data.mainImplementer, parsed.data.councilMembers)
    if (parsed.data.chatModel !== undefined) {
      chatModel = parsed.data.chatModel && parsed.data.chatModelVariant
        ? await validateConfiguredModel(parsed.data.chatModel, parsed.data.chatModelVariant)
        : await validateConfiguredModel(parsed.data.chatModel)
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid model configuration' }, 400)
  }
  const existing = db.select().from(profiles).limit(1).get()
  if (existing) {
    return c.json({ error: 'Profile already exists. Use PATCH to update.' }, 409)
  }
  try {
    await registerSelectedRoutingModels([
      ...validatedModels.councilMembers,
      ...(chatModel ? [chatModel] : []),
    ])
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Unable to register OpenRouter routing models' },
      err instanceof ProviderCatalogBusyError ? 409 : 502,
    )
  }
  const result = db.insert(profiles).values({
    ...parsed.data,
    chatModel,
    chatModelVariant: chatModel ? parsed.data.chatModelVariant ?? null : null,
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

  let chatModelPatch: { chatModel: string | null } | undefined
  if (parsed.data.chatModel !== undefined) {
    try {
      const changingModel = parsed.data.chatModel !== existing.chatModel
      chatModelPatch = {
        chatModel: !changingModel
          ? existing.chatModel
          : parsed.data.chatModel && parsed.data.chatModelVariant
            ? await validateConfiguredModel(parsed.data.chatModel, parsed.data.chatModelVariant)
            : await validateConfiguredModel(parsed.data.chatModel),
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid chat model' }, 400)
    }
  }
  const chatModelChanged = chatModelPatch?.chatModel !== undefined && chatModelPatch.chatModel !== existing.chatModel
  const nextChatModel = chatModelPatch ? chatModelPatch.chatModel : existing.chatModel
  let chatModelVariantPatch: { chatModelVariant: string | null } | undefined
  if (!nextChatModel || (chatModelChanged && parsed.data.chatModelVariant === undefined)) {
    chatModelVariantPatch = { chatModelVariant: null }
  } else if (parsed.data.chatModelVariant !== undefined) {
    try {
      if (
        parsed.data.chatModelVariant
        && !chatModelChanged
        && parsed.data.chatModelVariant !== existing.chatModelVariant
      ) {
        await validateConfiguredModel(nextChatModel, parsed.data.chatModelVariant)
      }
      chatModelVariantPatch = { chatModelVariant: parsed.data.chatModelVariant }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid chat model variant' }, 400)
    }
  }

  const requestedMainImplementer = parsed.data.mainImplementer ?? existing.mainImplementer
  const requestedCouncilMembers = parsed.data.councilMembers ?? existing.councilMembers
  let modelPatch: Pick<typeof existing, 'mainImplementer' | 'councilMembers'>
  const modelSelectionChanged = hasModelSelectionChange(existing, {
    mainImplementer: requestedMainImplementer,
    councilMembers: requestedCouncilMembers,
  })
  // Kept alongside the serialised column so the registration below does not
  // have to parse back what this handler has just validated and stringified.
  let councilMembersToRegister: string[]

  if (modelSelectionChanged) {
    let validatedModels
    try {
      validatedModels = await validateModelSelection(requestedMainImplementer, requestedCouncilMembers)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid model configuration' }, 400)
    }

    councilMembersToRegister = validatedModels.councilMembers
    modelPatch = {
      mainImplementer: validatedModels.mainImplementer,
      councilMembers: JSON.stringify(validatedModels.councilMembers),
    }
  } else {
    const normalizedRequested = normalizeModelSelection(requestedMainImplementer, requestedCouncilMembers)
    councilMembersToRegister = normalizedRequested.councilMembers
    modelPatch = {
      mainImplementer: normalizedRequested.mainImplementer || existing.mainImplementer,
      councilMembers: JSON.stringify(normalizedRequested.councilMembers),
    }
  }
  const chatModelToRegister = chatModelPatch ? chatModelPatch.chatModel : existing.chatModel

  try {
    if (modelSelectionChanged || chatModelChanged) {
      await registerSelectedRoutingModels([
        ...councilMembersToRegister,
        ...(chatModelToRegister ? [chatModelToRegister] : []),
      ])
    }
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Unable to register OpenRouter routing models' },
      err instanceof ProviderCatalogBusyError ? 409 : 502,
    )
  }

  const result = db.update(profiles)
    .set({
      ...parsed.data,
      ...chatModelPatch,
      ...chatModelVariantPatch,
      ...modelPatch,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(profiles.id, existing.id))
    .returning()
    .get()
  return c.json(result)
})

export { profileRouter }
