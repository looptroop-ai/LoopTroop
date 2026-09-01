import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildPromptGroups,
  catalogEntry,
  GLOBAL_RULE_PROMPT_IDS,
} from '@shared/promptCatalog'
import { previewPrompt } from '../prompts/index'
import {
  GLOBAL_RULE_DESCRIPTIONS,
  getGlobalRuleText,
  type GlobalRuleId,
} from '../prompts/globalRules'
import { parseGlobalRule, parsePromptTemplate } from '../prompts/templateFile'
import {
  defaultGlobalRuleText,
  defaultPromptTemplate,
  getLoadWarnings,
  isGlobalRuleId,
  isPromptId,
  isPromptModified,
  readDefaultPromptSource,
  readPromptSource,
  resetAllPrompts,
  revertPrompt,
  saveGlobalRule,
  savePromptTemplate,
  templatesDir,
  type EditablePromptId,
} from '../prompts/templateStore'
import { getErrorMessage } from '@shared/typeGuards'

const promptsRouter = new Hono()

const saveSchema = z.object({ source: z.string().min(1) })

function isEditableId(id: string): id is EditablePromptId {
  return isPromptId(id) || isGlobalRuleId(id)
}

function describePrompt(id: EditablePromptId): string {
  return isGlobalRuleId(id)
    ? GLOBAL_RULE_DESCRIPTIONS[id]
    : defaultPromptTemplate(id).description
}

promptsRouter.get('/prompts', (c) => {
  const groups = buildPromptGroups().map((group) => ({
    id: group.id,
    label: group.label,
    statuses: group.statuses.map((status) => ({
      status: status.status,
      label: status.label,
      prompts: status.promptIds
        .filter(isEditableId)
        .map((promptId) => ({
          id: promptId,
          description: describePrompt(promptId),
          step: catalogEntry(promptId)?.step ?? null,
          modified: isPromptModified(promptId),
        })),
    })),
  }))

  const modifiedCount = groups
    .flatMap((group) => group.statuses)
    .flatMap((status) => status.prompts)
    .filter((prompt) => prompt.modified).length

  return c.json({
    groups,
    modifiedCount,
    templatesDir: templatesDir(),
    warnings: getLoadWarnings(),
  })
})

promptsRouter.get('/prompts/:id', (c) => {
  const id = c.req.param('id')
  if (!isEditableId(id)) return c.json({ error: 'Unknown prompt id' }, 404)

  return c.json({
    id,
    description: describePrompt(id),
    kind: isGlobalRuleId(id) ? 'global_rule' : 'template',
    current: readPromptSource(id),
    default: readDefaultPromptSource(id),
    modified: isPromptModified(id),
  })
})

promptsRouter.post('/prompts/:id/preview', async (c) => {
  const id = c.req.param('id')
  if (!isEditableId(id)) return c.json({ error: 'Unknown prompt id' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsedBody = saveSchema.safeParse(body)
  const source = parsedBody.success ? parsedBody.data.source : readPromptSource(id)

  try {
    if (isGlobalRuleId(id)) {
      // A rule block is only meaningful in front of a template; show it verbatim.
      return c.json({ preview: parseGlobalRule(source).text })
    }
    const template = parsePromptTemplate(source)
    const rules = getGlobalRuleText(resolveRuleIdForPrompt(id))
    return c.json({ preview: previewPrompt(rules, template) })
  } catch (error) {
    return c.json({ error: getErrorMessage(error) }, 400)
  }
})

/**
 * Which rule block gets prepended to a given prompt at runtime, mirroring the
 * builder each call site uses. Kept in sync with the
 * `buildSameSessionPromptFromTemplate` / `buildConversationalPrompt` callers.
 */
const SAME_SESSION_PROMPT_IDS = new Set(['PROM51', 'PROM_EXECUTION_SETUP_NOTE'])
const CONVERSATIONAL_PROMPT_IDS = new Set(['PROM4'])

function resolveRuleIdForPrompt(id: string): GlobalRuleId {
  if (SAME_SESSION_PROMPT_IDS.has(id)) return 'GENERAL_SAME_SESSION_RULES'
  if (CONVERSATIONAL_PROMPT_IDS.has(id)) return 'GENERAL_CONVERSATIONAL_RULES'
  return 'GENERAL_GLOBAL_RULES'
}

promptsRouter.put('/prompts/:id', async (c) => {
  const id = c.req.param('id')
  if (!isEditableId(id)) return c.json({ error: 'Unknown prompt id' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsedBody = saveSchema.safeParse(body)
  if (!parsedBody.success) {
    return c.json({ errors: ['Request body must include a non-empty `source` string'], warnings: [] }, 400)
  }

  if (isGlobalRuleId(id)) {
    let text: string
    try {
      text = parseGlobalRule(parsedBody.data.source).text
    } catch (error) {
      return c.json(
        { errors: [getErrorMessage(error)], warnings: [] },
        400,
      )
    }
    const result = saveGlobalRule(id, text)
    if (result.errors.length > 0) return c.json(result, 400)
    return c.json({ ...result, modified: text !== defaultGlobalRuleText(id) })
  }

  const result = savePromptTemplate(id, parsedBody.data.source)
  if (result.errors.length > 0) return c.json(result, 400)
  return c.json({ ...result, modified: isPromptModified(id) })
})

promptsRouter.post('/prompts/:id/revert', (c) => {
  const id = c.req.param('id')
  if (!isEditableId(id)) return c.json({ error: 'Unknown prompt id' }, 404)
  revertPrompt(id)
  return c.json({ id, current: readPromptSource(id), modified: false })
})

promptsRouter.post('/prompts/reset-all', (c) => {
  resetAllPrompts()
  return c.json({ reset: true, templatesDir: templatesDir() })
})

export { promptsRouter, GLOBAL_RULE_PROMPT_IDS }
