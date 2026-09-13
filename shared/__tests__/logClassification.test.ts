import { describe, expect, it } from 'vitest'
import { getLogModelId, isAiLogEntry, isDebugLogEntry } from '../logClassification'
import { classifyPersistedLogEntry } from '../../server/log/view'

describe('shared log attribution', () => {
  it.each([
    [{ type: 'model_output' }, true, 'ai'],
    [{ audience: 'all', source: 'system', modelId: 'test/model' }, true, 'system'],
    [{ audience: 'all', source: 'system', sessionId: 'session-1' }, true, 'system'],
    [{ source: 'model:test/model', content: '[DEBUG] is a tag in model prose' }, true, 'ai'],
    [{ type: 'model_output', content: 'An example contains [DEBUG] here' }, true, 'ai'],
    [{ source: 'system', content: 'An example contains [DEBUG] here' }, false, 'system'],
    [{ source: 'system', content: ' [DEBUG] actual diagnostic' }, false, 'debug'],
    [{ type: 'debug', source: 'model:test/model' }, false, 'debug'],
    [{ source: 'debug', modelId: 'test/model' }, false, 'debug'],
    [{ audience: 'debug', sessionId: 'session-1' }, false, 'debug'],
    [{ source: 'model:' }, false, 'system'],
  ] as const)('classifies %j consistently without changing milestone categories', (entry, ai, category) => {
    expect(isAiLogEntry(entry)).toBe(ai)
    expect(isDebugLogEntry(entry)).toBe(category === 'debug')
    expect(classifyPersistedLogEntry(entry)).toBe(category)
  })

  it('uses the explicit model before the source and rejects empty identities', () => {
    expect(getLogModelId({ modelId: 'test/explicit', source: 'model:test/source' })).toBe('test/explicit')
    expect(getLogModelId({ modelId: '', source: 'model:test/source' })).toBe('test/source')
    expect(getLogModelId({ source: 'model:' })).toBeNull()
  })
})
