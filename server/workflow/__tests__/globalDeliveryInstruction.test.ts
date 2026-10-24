import { describe, expect, it } from 'vitest'
import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart } from '../../opencode/types'
import {
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
} from '../runOpenCodePrompt'

const deliveryInstruction = 'Leave GitHub writes and remote Git changes to LoopTroop; continue local work after refused actions.'

describe('runOpenCodeSessionPrompt delivery ownership instruction', () => {
  it('adds it once per dispatch and reports the actual prompt while preserving caller parts', async () => {
    const sourceParts: PromptPart[] = [
      { type: 'system', content: 'Keep the structured response in YAML.' },
      { type: 'text', content: 'Continue the local implementation.' },
    ]
    const promptCalls: PromptPart[][] = []
    const dispatched: OpenCodePromptDispatchEvent[] = []
    const completed: OpenCodePromptCompletedEvent[] = []
    const adapter = {
      promptSession: async (_sessionId: string, parts: PromptPart[]) => {
        promptCalls.push(parts)
        return 'done'
      },
      getSessionMessages: async () => [],
    } as unknown as OpenCodeAdapter

    for (let promptNumber = 0; promptNumber < 2; promptNumber += 1) {
      await runOpenCodeSessionPrompt({
        adapter,
        session: { id: 'session-1' },
        parts: sourceParts,
        onPromptDispatched: (event) => dispatched.push(event),
        onPromptCompleted: (event) => completed.push(event),
      })
    }

    const expectedParts = [...sourceParts, { type: 'system' as const, content: deliveryInstruction }]
    expect(promptCalls).toEqual([expectedParts, expectedParts])
    expect(dispatched.map((event) => event.parts)).toEqual([expectedParts, expectedParts])
    expect(dispatched.map((event) => event.promptText.split(deliveryInstruction).length - 1)).toEqual([1, 1])
    expect(completed.map((event) => event.parts)).toEqual([expectedParts, expectedParts])
    expect(sourceParts).toEqual([
      { type: 'system', content: 'Keep the structured response in YAML.' },
      { type: 'text', content: 'Continue the local implementation.' },
    ])
  })
})
