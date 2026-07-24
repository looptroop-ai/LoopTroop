import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../../../shared/openRouterRouting'
import { registerOpenRouterRoutingModels } from '../openRouterRoutingConfig'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('registerOpenRouterRoutingModels', () => {
  it('adds selected routing suffixes to the managed OpenCode config without changing base models', () => {
    const directory = mkdtempSync(join(tmpdir(), 'looptroop-routing-config-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)

    expect(registerOpenRouterRoutingModels([
      'openrouter/deepseek/deepseek-v4-flash:floor',
      'openrouter/anthropic/claude-sonnet-4:nitro',
      'openrouter/google/gemini-2.5-pro',
      'openai/gpt-5.4',
    ])).toBe(true)
    expect(registerOpenRouterRoutingModels(['openrouter/deepseek/deepseek-v4-flash:floor'])).toBe(false)

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      provider: {
        openrouter: {
          models: {
            'deepseek/deepseek-v4-flash:floor': {},
            'anthropic/claude-sonnet-4:nitro': {},
          },
        },
      },
    })
  })
})
