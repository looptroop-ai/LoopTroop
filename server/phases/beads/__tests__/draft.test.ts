import { beforeEach, describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { draftBeads } from '../draft'
import type { CouncilMember } from '../../../council/types'
import type { PromptPart } from '../../../opencode/types'

describe('draftBeads', () => {
  let adapter: MockOpenCodeAdapter

  const members: CouncilMember[] = [
    { modelId: 'model-a', name: 'Model A' },
  ]

  const ticketContext: PromptPart[] = [
    { type: 'text', content: 'Draft the next bead subset for UI theme typing.' },
  ]

  beforeEach(() => {
    adapter = new MockOpenCodeAdapter()
  })

  it('keeps repaired quoted-scalar bead drafts as completed instead of invalid_output', async () => {
    adapter.mockResponses.set('mock-session-1', [
      'beads:',
      '  - id: bead-1',
      '    title: Tighten theme typing',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Keep UIState theme values typed and explicit.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep UIState as the source of truth for theme values.',
      '      anti_patterns:',
      '        - Do not widen theme to string.',
      '    acceptanceCriteria:',
      "      - 'pink' is accepted as a valid theme value in UIState.",
      '    tests:',
      '      - Theme reducer tests cover the pink path.',
      '    testCommands:',
      '      - mode: "process"',
      '        program: "npm"',
      '        args: ["run", "test:server"]',
      '        cwd: "."',
      '        env: {}',
    ].join('\n'))

    const result = await draftBeads(
      adapter,
      members,
      ticketContext,
      '/tmp/test',
      {
        draftTimeoutMs: 300000,
        minQuorum: 1,
      },
    )

    expect(result.memberOutcomes['model-a']).toBe('completed')
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]!.outcome).toBe('completed')
    expect(result.drafts[0]!.structuredOutput?.repairApplied).toBe(true)
    expect(result.drafts[0]!.structuredOutput?.repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(result.drafts[0]!.structuredOutput?.autoRetryCount).toBe(0)
    expect(result.drafts[0]!.draftMetrics?.beadCount).toBe(1)
  })

  it('keeps repaired quoted block-scalar bead drafts as completed after a structured retry', async () => {
    adapter.mockResponses.set('mock-session-1', [
      'beads:',
      '  - id: bead-1',
      '    title: Recover quoted block scalar indicator',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Keep the parser retry focused on real validation failures first.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      '      - Retry only when required by validation.',
      '    tests:',
      '      - First attempt intentionally omits testCommands.',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-2', [
      'beads:',
      '  - id: bead-1',
      '    title: Recover quoted block scalar indicator',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: "|-"',
      '      Edit ui/src/scss/_vars.scss and replace the default token.',
      '      Preserve the emitted body text exactly.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      '      - Parser accepts the repaired block scalar.',
      '    tests:',
      '      - Structured retry recovers the malformed indicator.',
      '    testCommands:',
      '      - mode: "process"',
      '        program: "npm"',
      '        args: ["run", "test:server"]',
      '        cwd: "."',
      '        env: {}',
    ].join('\n'))

    const result = await draftBeads(
      adapter,
      members,
      ticketContext,
      '/tmp/test',
      {
        draftTimeoutMs: 300000,
        minQuorum: 1,
      },
    )

    expect(result.memberOutcomes['model-a']).toBe('completed')
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]!.outcome).toBe('completed')
    expect(result.drafts[0]!.structuredOutput?.repairApplied).toBe(true)
    expect(result.drafts[0]!.structuredOutput?.repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(result.drafts[0]!.structuredOutput?.autoRetryCount).toBe(1)
    expect(result.drafts[0]!.structuredOutput?.retryDiagnostics).toHaveLength(1)
    expect(result.drafts[0]!.draftMetrics?.beadCount).toBe(1)
  })
})
