import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../../../shared/openRouterRouting'
import {
  openRouterRoutingModelsWouldChangeConfig,
  registerOpenRouterRoutingModels,
} from '../openRouterRoutingConfig'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTempDir(directory)
  }
})

describe('registerOpenRouterRoutingModels', () => {
  it('adds selected routing suffixes to the managed OpenCode config without changing base models', () => {
    const directory = makeTempDir('looptroop-routing-config-')
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)

    expect(openRouterRoutingModelsWouldChangeConfig(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v1')).toBe(true)
    expect(registerOpenRouterRoutingModels([
      'openrouter/deepseek/deepseek-v4-flash:floor',
      'openrouter/anthropic/claude-sonnet-4:nitro',
      'openrouter/google/gemini-2.5-pro',
      'openai/gpt-5.4',
    ], 'v1')).toBe(true)
    expect(openRouterRoutingModelsWouldChangeConfig(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v1')).toBe(false)
    expect(registerOpenRouterRoutingModels(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v1')).toBe(false)

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

  it('writes v2 routes under native providers and preserves legacy fields and provider overrides', () => {
    const directory = makeTempDir('looptroop-routing-config-v2-')
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    const original = {
      providers: {
        openrouter: {
          models: { existing: { name: 'existing', options: { temperature: 0.4 } } },
          options: { baseURL: 'https://provider.example' },
        },
      },
      provider: { openrouter: { models: { legacy: { name: 'legacy' } } } },
      unrelated: { preserve: true },
    }
    writeFileSync(configPath, JSON.stringify(original))

    expect(openRouterRoutingModelsWouldChangeConfig(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v2')).toBe(true)
    expect(registerOpenRouterRoutingModels([
      'openrouter/deepseek/deepseek-v4-flash:floor',
      'openai/gpt-5.4',
    ], 'v2')).toBe(true)
    expect(openRouterRoutingModelsWouldChangeConfig(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v2')).toBe(false)
    expect(registerOpenRouterRoutingModels(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v2')).toBe(false)

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      providers: {
        openrouter: {
          models: {
            existing: { name: 'existing', options: { temperature: 0.4 } },
            'deepseek/deepseek-v4-flash:floor': {},
          },
          options: { baseURL: 'https://provider.example' },
        },
      },
      provider: { openrouter: { models: { legacy: { name: 'legacy' } } } },
      unrelated: { preserve: true },
    })
  })

  it('keeps v2 routes in an existing legacy provider map when no native map exists', () => {
    const directory = makeTempDir('looptroop-routing-config-v2-legacy-')
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    const original = {
      provider: {
        openrouter: {
          models: { existing: { name: 'existing' } },
          options: { baseURL: 'https://provider.example' },
        },
      },
      unrelated: { preserve: true },
    }
    writeFileSync(configPath, JSON.stringify(original))

    expect(registerOpenRouterRoutingModels(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v2')).toBe(true)

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      provider: {
        openrouter: {
          models: {
            existing: { name: 'existing' },
            'deepseek/deepseek-v4-flash:floor': {},
          },
          options: { baseURL: 'https://provider.example' },
        },
      },
      unrelated: { preserve: true },
    })
  })

  it('does not rewrite ignored legacy routes when native v2 routes already exist', () => {
    const directory = makeTempDir('looptroop-routing-config-v2-native-')
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'opencode.json')
    vi.stubEnv(LOOPTROOP_OPENCODE_ROUTING_CONFIG, configPath)
    const original = {
      providers: { openrouter: { models: { 'deepseek/deepseek-v4-flash:floor': { native: true } } } },
      provider: { openrouter: { models: {} } },
    }
    writeFileSync(configPath, JSON.stringify(original))

    expect(registerOpenRouterRoutingModels(['openrouter/deepseek/deepseek-v4-flash:floor'], 'v2')).toBe(false)
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(original)
  })
})
