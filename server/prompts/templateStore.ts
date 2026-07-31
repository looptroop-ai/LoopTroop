import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { resolveAppConfigDir } from '../lib/appConfigDir'
import { ALL_PROMPTS, setPromptTemplateResolver, type PromptTemplate } from './index'
import {
  DEFAULT_GLOBAL_RULE_TEXTS,
  GLOBAL_RULE_DESCRIPTIONS,
  clearGlobalRuleOverrides,
  setGlobalRuleOverride,
  type GlobalRuleId,
} from './globalRules'
import {
  parseGlobalRule,
  parsePromptTemplate,
  serializeGlobalRule,
  serializePromptTemplate,
  validatePromptTemplate,
  type TemplateValidationResult,
} from './templateFile'

const GLOBAL_RULE_IDS = Object.keys(DEFAULT_GLOBAL_RULE_TEXTS) as GlobalRuleId[]

export type PromptId = keyof typeof ALL_PROMPTS
export type EditablePromptId = PromptId | GlobalRuleId

export interface PromptLoadWarning {
  id: string
  message: string
}

interface StoreState {
  templates: Map<string, PromptTemplate>
  rules: Map<GlobalRuleId, string>
  warnings: PromptLoadWarning[]
  loaded: boolean
}

const state: StoreState = {
  templates: new Map(),
  rules: new Map(),
  warnings: [],
  loaded: false,
}

export function templatesDir(): string {
  return resolve(resolveAppConfigDir(), 'templates')
}

function templatePath(id: string): string {
  return resolve(templatesDir(), `${id}.yaml`)
}

export function isGlobalRuleId(id: string): id is GlobalRuleId {
  return (GLOBAL_RULE_IDS as string[]).includes(id)
}

export function isPromptId(id: string): id is PromptId {
  return Object.prototype.hasOwnProperty.call(ALL_PROMPTS, id)
}

export function defaultPromptTemplate(id: PromptId): PromptTemplate {
  return ALL_PROMPTS[id] as PromptTemplate
}

export function allDefaultPromptTemplates(): PromptTemplate[] {
  return (Object.keys(ALL_PROMPTS) as PromptId[]).map(defaultPromptTemplate)
}

export function defaultGlobalRuleText(id: GlobalRuleId): string {
  return DEFAULT_GLOBAL_RULE_TEXTS[id]
}

/**
 * Write built-in defaults for any template file that does not yet exist.
 * Existing files are never overwritten so user edits survive upgrades.
 */
export function bootstrapTemplates(): void {
  const dir = templatesDir()
  mkdirSync(dir, { recursive: true })

  for (const template of allDefaultPromptTemplates()) {
    const path = templatePath(template.id)
    if (!existsSync(path)) {
      writeFileSync(path, serializePromptTemplate(template), 'utf-8')
    }
  }

  for (const ruleId of GLOBAL_RULE_IDS) {
    const path = templatePath(ruleId)
    if (!existsSync(path)) {
      writeFileSync(
        path,
        serializeGlobalRule(ruleId, GLOBAL_RULE_DESCRIPTIONS[ruleId], DEFAULT_GLOBAL_RULE_TEXTS[ruleId]),
        'utf-8',
      )
    }
  }
}

/**
 * Read every template file into memory. Invalid or unreadable files are logged
 * as warnings and fall back to the built-in default, so a corrupt file can
 * never stop a workflow phase from running.
 */
export function loadTemplates(): PromptLoadWarning[] {
  const warnings: PromptLoadWarning[] = []
  state.templates.clear()
  state.rules.clear()
  clearGlobalRuleOverrides()

  const dir = templatesDir()
  if (!existsSync(dir)) {
    state.warnings = warnings
    state.loaded = true
    return warnings
  }

  const files = new Set(readdirSync(dir).filter((name) => name.endsWith('.yaml')))

  for (const template of allDefaultPromptTemplates()) {
    if (!files.has(`${template.id}.yaml`)) continue
    try {
      const parsed = parsePromptTemplate(readFileSync(templatePath(template.id), 'utf-8'))
      const { errors } = validatePromptTemplate(parsed, template)
      if (errors.length > 0) {
        warnings.push({ id: template.id, message: `Using built-in default: ${errors.join('; ')}` })
        continue
      }
      state.templates.set(template.id, parsed)
    } catch (error) {
      warnings.push({
        id: template.id,
        message: `Using built-in default: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  for (const ruleId of GLOBAL_RULE_IDS) {
    if (!files.has(`${ruleId}.yaml`)) continue
    try {
      const parsed = parseGlobalRule(readFileSync(templatePath(ruleId), 'utf-8'))
      if (parsed.text.trim() === '') {
        warnings.push({ id: ruleId, message: 'Using built-in default: `text` cannot be empty' })
        continue
      }
      state.rules.set(ruleId, parsed.text)
      setGlobalRuleOverride(ruleId, parsed.text)
    } catch (error) {
      warnings.push({
        id: ruleId,
        message: `Using built-in default: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  state.warnings = warnings
  state.loaded = true
  return warnings
}

export function getLoadWarnings(): PromptLoadWarning[] {
  return state.warnings
}

function ensureLoaded(): void {
  if (!state.loaded) loadTemplates()
}

export function getPromptTemplate(id: PromptId): PromptTemplate {
  ensureLoaded()
  return state.templates.get(id) ?? defaultPromptTemplate(id)
}

export function getGlobalRule(id: GlobalRuleId): string {
  ensureLoaded()
  return state.rules.get(id) ?? DEFAULT_GLOBAL_RULE_TEXTS[id]
}

export function isPromptModified(id: EditablePromptId): boolean {
  ensureLoaded()
  if (isGlobalRuleId(id)) {
    const current = state.rules.get(id)
    return current !== undefined && current !== DEFAULT_GLOBAL_RULE_TEXTS[id]
  }
  const current = state.templates.get(id)
  if (!current) return false
  return serializePromptTemplate(current) !== serializePromptTemplate(defaultPromptTemplate(id))
}

export function savePromptTemplate(id: PromptId, source: string): TemplateValidationResult {
  const defaultTemplate = defaultPromptTemplate(id)
  let parsed: PromptTemplate
  try {
    parsed = parsePromptTemplate(source)
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings: [] }
  }

  const result = validatePromptTemplate(parsed, defaultTemplate)
  if (result.errors.length > 0) return result

  mkdirSync(templatesDir(), { recursive: true })
  writeFileSync(templatePath(id), serializePromptTemplate(parsed), 'utf-8')
  ensureLoaded()
  state.templates.set(id, parsed)
  return result
}

export function saveGlobalRule(id: GlobalRuleId, text: string): TemplateValidationResult {
  if (text.trim() === '') {
    return { errors: ['Rule text cannot be empty'], warnings: [] }
  }
  mkdirSync(templatesDir(), { recursive: true })
  writeFileSync(
    templatePath(id),
    serializeGlobalRule(id, GLOBAL_RULE_DESCRIPTIONS[id], text),
    'utf-8',
  )
  ensureLoaded()
  state.rules.set(id, text)
  setGlobalRuleOverride(id, text)
  return { errors: [], warnings: [] }
}

export function revertPrompt(id: EditablePromptId): void {
  ensureLoaded()
  const path = templatePath(id)
  if (existsSync(path)) rmSync(path)

  if (isGlobalRuleId(id)) {
    state.rules.delete(id)
    setGlobalRuleOverride(id, null)
    writeFileSync(
      path,
      serializeGlobalRule(id, GLOBAL_RULE_DESCRIPTIONS[id], DEFAULT_GLOBAL_RULE_TEXTS[id]),
      'utf-8',
    )
    return
  }

  state.templates.delete(id)
  writeFileSync(path, serializePromptTemplate(defaultPromptTemplate(id)), 'utf-8')
}

export function resetAllPrompts(): void {
  const dir = templatesDir()
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  bootstrapTemplates()
  loadTemplates()
}

export function readPromptSource(id: EditablePromptId): string {
  ensureLoaded()
  const path = templatePath(id)
  if (existsSync(path)) {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      // fall through to the default rendering below
    }
  }
  return readDefaultPromptSource(id)
}

export function readDefaultPromptSource(id: EditablePromptId): string {
  if (isGlobalRuleId(id)) {
    return serializeGlobalRule(id, GLOBAL_RULE_DESCRIPTIONS[id], DEFAULT_GLOBAL_RULE_TEXTS[id])
  }
  return serializePromptTemplate(defaultPromptTemplate(id))
}

/**
 * Bootstrap files, load overrides, and register the resolver so every prompt
 * built by `server/prompts/index.ts` picks up user customizations.
 */
export function initPromptTemplates(): PromptLoadWarning[] {
  bootstrapTemplates()
  const warnings = loadTemplates()
  setPromptTemplateResolver((template) => state.templates.get(template.id) ?? template)
  return warnings
}
