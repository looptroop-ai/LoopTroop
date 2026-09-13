import { describe, expect, it } from 'vitest'
import { classifyPersistedLogEntry, normalizePersistedLogEntry } from '../view'

describe('persisted log display defaults', () => {
  it.each([
    [{ type: 'model_output' }, 'ai', 'text'],
    [{ type: 'info', source: 'opencode' }, 'ai', 'session'],
    [{ type: 'info', modelId: 'test/model' }, 'ai', 'session'],
    [{ type: 'info', source: 'system', modelId: 'test/model' }, 'all', 'milestone'],
    [{ type: 'model_output', source: 'system' }, 'all', 'milestone'],
    [{ type: 'error', modelId: 'test/model' }, 'ai', 'error'],
    [{ type: 'test_result', modelId: 'test/model' }, 'ai', 'test'],
    [{ type: 'info', source: 'opencode', audience: 'all', kind: 'milestone' }, 'all', 'milestone'],
    [{ type: 'model_output', audience: 'ai', kind: 'tool' }, 'ai', 'tool'],
  ] as const)('normalizes %j using client display precedence', (raw, audience, kind) => {
    expect(normalizePersistedLogEntry(raw)).toMatchObject({ audience, kind })
  })

  it('keeps an explicitly system-sourced model milestone in SYS', () => {
    const normalized = normalizePersistedLogEntry({ type: 'info', source: 'system', modelId: 'test/model' })!
    expect(classifyPersistedLogEntry(normalized)).toBe('system')
  })
})
