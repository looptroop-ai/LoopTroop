import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { ALL_PROMPTS } from '../index'
import { PROMPT_CATALOG, buildPromptGroups, GLOBAL_RULE_PROMPT_IDS } from '@shared/promptCatalog'
import {
  parsePromptTemplate,
  serializePromptTemplate,
  validatePromptTemplate,
} from '../templateFile'

let configDir: string
const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR

beforeEach(() => {
  configDir = makeTempDir('looptroop-prompts-')
  process.env.LOOPTROOP_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  removeTempDir(configDir)
})

// The store reads LOOPTROOP_CONFIG_DIR at call time, so import it lazily per test.
async function store() {
  return await import('../templateStore')
}

describe('prompt template YAML round-trip', () => {
  it('serializes and re-parses every built-in prompt without loss', () => {
    for (const template of Object.values(ALL_PROMPTS)) {
      const source = serializePromptTemplate(template)
      const parsed = parsePromptTemplate(source)
      expect(serializePromptTemplate(parsed), `round-trip mismatch for ${template.id}`).toBe(source)
      expect(validatePromptTemplate(parsed, template).errors).toEqual([])
    }
  })
})

describe('prompt catalog coverage', () => {
  it('lists every built-in prompt exactly once', () => {
    const catalogIds = PROMPT_CATALOG.map((entry) => entry.id)
    expect(new Set(catalogIds).size).toBe(catalogIds.length)
    expect([...catalogIds].sort()).toEqual(Object.keys(ALL_PROMPTS).sort())
  })

  it('places the global rules in a trailing General group', () => {
    const groups = buildPromptGroups()
    const last = groups[groups.length - 1]
    expect(last?.id).toBe('general')
    const generalIds = last?.statuses.flatMap((status) => status.promptIds) ?? []
    expect([...generalIds].sort()).toEqual([...GLOBAL_RULE_PROMPT_IDS].sort())
  })
})

describe('template store', () => {
  it('bootstraps a file per prompt without overwriting user edits', async () => {
    const { bootstrapTemplates, templatesDir } = await store()
    bootstrapTemplates()

    const path = resolve(templatesDir(), 'PROM0.yaml')
    expect(existsSync(path)).toBe(true)

    const edited = readFileSync(path, 'utf-8').replace('description:', 'description:')
    writeFileSync(path, `${edited}\n# user comment\n`, 'utf-8')
    bootstrapTemplates()
    expect(readFileSync(path, 'utf-8')).toContain('# user comment')
  })

  it('falls back to the built-in default when a file is corrupt', async () => {
    const { bootstrapTemplates, loadTemplates, getPromptTemplate, templatesDir } = await store()
    bootstrapTemplates()
    writeFileSync(resolve(templatesDir(), 'PROM0.yaml'), ':::not valid yaml:::\n  - [', 'utf-8')

    const warnings = loadTemplates()
    expect(warnings.some((warning) => warning.id === 'PROM0')).toBe(true)
    expect(getPromptTemplate('PROM0').task).toBe(ALL_PROMPTS.PROM0.task)
  })

  it('saves, reports modified, and reverts a prompt', async () => {
    const { initPromptTemplates, savePromptTemplate, isPromptModified, revertPrompt } = await store()
    initPromptTemplates()

    expect(isPromptModified('PROM0')).toBe(false)

    const source = serializePromptTemplate({ ...ALL_PROMPTS.PROM0, task: 'A customized task line.' })
    expect(savePromptTemplate('PROM0', source).errors).toEqual([])
    expect(isPromptModified('PROM0')).toBe(true)

    revertPrompt('PROM0')
    expect(isPromptModified('PROM0')).toBe(false)
  })

  it('rejects an edit that changes the prompt id or empties a required field', async () => {
    const { initPromptTemplates, savePromptTemplate } = await store()
    initPromptTemplates()

    const renamed = serializePromptTemplate({ ...ALL_PROMPTS.PROM0, id: 'PROM_RENAMED' })
    expect(savePromptTemplate('PROM0', renamed).errors.length).toBeGreaterThan(0)

    const emptied = serializePromptTemplate({ ...ALL_PROMPTS.PROM0, task: '' })
    expect(savePromptTemplate('PROM0', emptied).errors.length).toBeGreaterThan(0)
  })

  it('applies a saved global rule override to built prompts', async () => {
    const { initPromptTemplates, saveGlobalRule, getGlobalRule } = await store()
    initPromptTemplates()

    expect(saveGlobalRule('GENERAL_GLOBAL_RULES', 'Custom rules block.').errors).toEqual([])
    expect(getGlobalRule('GENERAL_GLOBAL_RULES')).toBe('Custom rules block.')
  })
})
