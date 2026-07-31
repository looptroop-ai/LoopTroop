import * as jsYaml from 'js-yaml'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import type { PromptTemplate } from './index'

export interface TemplateValidationResult {
  errors: string[]
  warnings: string[]
}

const TOOL_POLICIES: readonly OpenCodeToolPolicy[] = [
  'default',
  'disabled',
  'read_only',
  'execution_setup_online',
]

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Serialize a prompt template to YAML using block scalars for the long
 * free-text fields so hand-editing stays comfortable.
 */
export function serializePromptTemplate(template: PromptTemplate): string {
  return jsYaml.dump(
    {
      id: template.id,
      description: template.description,
      systemRole: template.systemRole,
      task: template.task,
      instructions: template.instructions,
      outputFormat: template.outputFormat,
      contextInputs: template.contextInputs,
      toolPolicy: template.toolPolicy,
    },
    { lineWidth: -1, noRefs: true },
  )
}

export function serializeGlobalRule(id: string, description: string, text: string): string {
  return jsYaml.dump({ id, description, text }, { lineWidth: -1, noRefs: true })
}

export interface ParsedGlobalRule {
  id: string
  text: string
}

export function parseGlobalRule(source: string): ParsedGlobalRule {
  const raw = jsYaml.load(source)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Global rule file must contain a YAML mapping')
  }
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new Error('Global rule file is missing a string `id`')
  }
  if (typeof record.text !== 'string') {
    throw new Error('Global rule file is missing a string `text`')
  }
  return { id: record.id, text: record.text }
}

/**
 * Parse a prompt template YAML file. Throws on structurally invalid input so
 * callers can fall back to the built-in default.
 */
export function parsePromptTemplate(source: string): PromptTemplate {
  const raw = jsYaml.load(source)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Prompt template file must contain a YAML mapping')
  }
  const record = raw as Record<string, unknown>

  const requireString = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string') {
      throw new Error(`Prompt template field \`${key}\` must be a string`)
    }
    return value
  }

  const requireStringArray = (key: string): string[] => {
    const value = record[key]
    if (value === undefined || value === null) return []
    if (!isStringArray(value)) {
      throw new Error(`Prompt template field \`${key}\` must be a list of strings`)
    }
    return value
  }

  const toolPolicy = record.toolPolicy
  if (typeof toolPolicy !== 'string' || !TOOL_POLICIES.includes(toolPolicy as OpenCodeToolPolicy)) {
    throw new Error(`Prompt template field \`toolPolicy\` must be one of: ${TOOL_POLICIES.join(', ')}`)
  }

  return {
    id: requireString('id'),
    description: requireString('description'),
    systemRole: requireString('systemRole'),
    task: requireString('task'),
    instructions: requireStringArray('instructions'),
    outputFormat: requireString('outputFormat'),
    contextInputs: requireStringArray('contextInputs'),
    toolPolicy: toolPolicy as OpenCodeToolPolicy,
  }
}

/**
 * Compare an edited template against its built-in default.
 *
 * Errors block saving. Warnings are advisory: the most common way to silently
 * break a phase is deleting a context placeholder the phase relies on.
 */
export function validatePromptTemplate(
  edited: PromptTemplate,
  defaultTemplate: PromptTemplate,
): TemplateValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (edited.id !== defaultTemplate.id) {
    errors.push(`Prompt id cannot be changed (expected "${defaultTemplate.id}", got "${edited.id}")`)
  }
  if (edited.task.trim() === '') {
    errors.push('`task` cannot be empty')
  }
  if (edited.systemRole.trim() === '') {
    errors.push('`systemRole` cannot be empty')
  }
  if (edited.outputFormat.trim() === '') {
    errors.push('`outputFormat` cannot be empty')
  }
  if (edited.description.trim() === '') {
    errors.push('`description` cannot be empty')
  }

  const missingContextInputs = defaultTemplate.contextInputs.filter(
    (input) => !edited.contextInputs.includes(input),
  )
  if (missingContextInputs.length > 0) {
    warnings.push(
      `Removed context input(s): ${missingContextInputs.join(', ')}. `
      + 'The phase still supplies this context, but the model is no longer told to expect it.',
    )
  }

  if (edited.toolPolicy !== defaultTemplate.toolPolicy) {
    warnings.push(
      `Tool policy changed from "${defaultTemplate.toolPolicy}" to "${edited.toolPolicy}". `
      + 'This changes what the model is allowed to do during this phase.',
    )
  }

  if (edited.instructions.length === 0 && defaultTemplate.instructions.length > 0) {
    warnings.push('All instructions were removed. Output quality for this phase will likely degrade.')
  }

  return { errors, warnings }
}
