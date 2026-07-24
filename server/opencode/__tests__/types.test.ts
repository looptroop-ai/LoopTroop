import { describe, expect, it } from 'vitest'
import { parseModelRef } from '../types'

describe('parseModelRef', () => {
  it('removes OpenRouter request suffixes before creating an OpenCode model selection', () => {
    expect(parseModelRef(' openrouter/deepseek/deepseek-v4-flash:floor ')).toEqual({
      providerID: 'openrouter',
      modelID: 'deepseek/deepseek-v4-flash',
    })
  })
})
