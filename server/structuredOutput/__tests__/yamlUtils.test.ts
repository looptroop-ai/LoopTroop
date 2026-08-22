import { describe, expect, it } from 'vitest'
import { buildStructuredRetryPrompt, getValueByAliases, parseYamlOrJsonCandidate } from '../yamlUtils'

describe.concurrent('buildStructuredRetryPrompt', () => {
  it('keeps retry prompts focused on schema correction only', () => {
    const prompt = buildStructuredRetryPrompt([], {
      validationError: 'missing schema_version',
      rawResponse: 'draft: nope',
    })

    expect(prompt[0]?.content).toContain('## Structured Output Retry')
    expect(prompt[0]?.content).toContain('missing schema_version')
    expect(prompt[0]?.content).not.toContain('Do not use tools.')
  })
})

describe.concurrent('parseYamlOrJsonCandidate', () => {
  const interviewNestedMappingChildren = {
    generated_by: ['winner_model', 'generated_at', 'canonicalization'],
    answer: ['skipped', 'selected_option_ids', 'free_text', 'answered_by', 'answered_at'],
    summary: ['goals', 'constraints', 'non_goals', 'final_free_form_answer'],
    approval: ['approved_by', 'approved_at'],
  } as const

  it('repairs inline sequence parents before YAML can accept them as plain scalars', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate(
      'questions: - id: Q01 phase: foundation question: What behavior should the API expose?',
      { repairWarnings },
    ) as {
      questions: Array<{ id: string; phase: string; question: string }>
    }

    expect(repairWarnings).toContain('Repaired inline YAML sequence or mapping syntax before parsing.')
    expect(parsed.questions).toEqual([
      {
        id: 'Q01',
        phase: 'foundation',
        question: 'What behavior should the API expose?',
      },
    ])
  })

  it('repairs compact inline interview mappings before YAML can accept the wrong scalar shape', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'generated_by: winner_model: "openai/gpt-5.3-codex" generated_at: "2026-04-30T15:29:00Z" canonicalization: server_normalized',
      'questions: - id: "Q01" phase: "Foundation" prompt: "What problem are we solving?" source: compiled follow_up_round: null answer_type: single_choice options: - id: opt1 label: "Keep behavior" - id: opt2 label: "Change behavior" answer: skipped: false selected_option_ids: - opt1 free_text: \'\' answered_by: ai_skip answered_at: "2026-04-30T15:29:00Z"',
      'summary: goals: [] constraints: [] non_goals: [] final_free_form_answer: ""',
      'approval: approved_by: "" approved_at: ""',
    ].join('\n'), {
      nestedMappingChildren: interviewNestedMappingChildren,
      repairWarnings,
    }) as {
      generated_by: { winner_model: string; generated_at: string; canonicalization: string }
      questions: Array<{
        options: Array<{ id: string; label: string }>
        answer: { selected_option_ids: string[]; answered_at: string }
      }>
    }

    expect(repairWarnings).toContain('Repaired inline YAML sequence or mapping syntax before parsing.')
    expect(parsed.generated_by).toEqual({
      winner_model: 'openai/gpt-5.3-codex',
      generated_at: '2026-04-30T15:29:00Z',
      canonicalization: 'server_normalized',
    })
    expect(parsed.questions[0]?.options).toEqual([
      { id: 'opt1', label: 'Keep behavior' },
      { id: 'opt2', label: 'Change behavior' },
    ])
    expect(parsed.questions[0]?.answer.selected_option_ids).toEqual(['opt1'])
  })

  it('quotes header-like list scalars before YAML can accept them as mappings', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'api_contracts:',
      '  - Content-Disposition: attachment; filename=synonyms.json',
      'gap_resolutions:',
      '  - gap: keep bead references typed',
      '    action: already_covered',
    ].join('\n'), { repairWarnings }) as {
      api_contracts: string[]
      gap_resolutions: Array<{ gap: string; action: string }>
    }

    expect(repairWarnings).toContain('Quoted YAML plain scalar values containing colon-space before reparsing.')
    expect(parsed.api_contracts).toEqual([
      'Content-Disposition: attachment; filename=synonyms.json',
    ])
    expect(parsed.gap_resolutions[0]).toEqual({
      gap: 'keep bead references typed',
      action: 'already_covered',
    })
  })

  it('preserves colon-containing scalar list items instead of turning them into mappings', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'values:',
      '  - style:main',
      '  - package:version',
      '  - https://example.test/path',
      '  - C:\\temp\\file.txt',
    ].join('\n'), { repairWarnings }) as { values: string[] }

    expect(parsed.values).toEqual([
      'style:main',
      'package:version',
      'https://example.test/path',
      'C:\\temp\\file.txt',
    ])
    expect(repairWarnings).not.toContain('Repaired YAML mapping keys missing a space after colon before parsing.')
  })

  it('repairs missing list-item mapping separators when an indented child proves the structure', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'items:',
      '  - id:Q01',
      '    title: Example item',
    ].join('\n'), { repairWarnings }) as { items: Array<{ id: string; title: string }> }

    expect(parsed.items).toEqual([{ id: 'Q01', title: 'Example item' }])
    expect(repairWarnings).toContain('Repaired YAML mapping keys missing a space after colon before parsing.')
  })

  it('keeps process command arguments containing colons as strings', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'verification:',
      '  required_commands:',
      '    - mode: process',
      '      program: npm',
      '      args:',
      '        - run',
      '        - style:main',
      '        - test:doc',
      '      cwd: .',
      '      env: {}',
    ].join('\n'), { repairWarnings }) as {
      verification: { required_commands: Array<{ args: unknown[] }> }
    }

    expect(parsed.verification.required_commands[0]?.args).toEqual(['run', 'style:main', 'test:doc'])
    expect(repairWarnings).not.toContain('Repaired YAML mapping keys missing a space after colon before parsing.')
  })

  it('folds wrapped colon-containing list prose through the shared parser', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'acceptance_criteria:',
      '  - `Object.getOwnPropertyDescriptor(fn, approvedProperty)` reports `writable: false`, `enumerable: false`, and',
      '    `configurable: false`.',
      '  - Existing validation remains unchanged.',
    ].join('\n'), { repairWarnings }) as { acceptance_criteria: string[] }

    expect(repairWarnings).toContain('Folded wrapped YAML list scalar text containing colon-space before reparsing.')
    expect(parsed.acceptance_criteria).toEqual([
      '`Object.getOwnPropertyDescriptor(fn, approvedProperty)` reports `writable: false`, `enumerable: false`, and `configurable: false`.',
      'Existing validation remains unchanged.',
    ])
  })

  it('repairs bare primary-key sequence items only when a parser opts in', () => {
    const content = [
      'beads:',
      '  - config-xml-json-marshalling',
      '    title: Implement XML/JSON unmarshalling',
    ].join('\n')
    const repairWarnings: string[] = []

    expect(() => parseYamlOrJsonCandidate(content)).toThrow()

    const parsed = parseYamlOrJsonCandidate(content, {
      sequenceItemPrimaryKeys: {
        beads: { primaryKey: 'id', childKeys: ['title'] },
      },
      repairWarnings,
    }) as { beads: Array<{ id: string; title: string }> }

    expect(parsed.beads[0]).toEqual({
      id: 'config-xml-json-marshalling',
      title: 'Implement XML/JSON unmarshalling',
    })
    expect(repairWarnings).toEqual([
      'Repaired YAML sequence entry under "beads" at line 2: treated bare item "config-xml-json-marshalling" as id before parsing.',
    ])
  })

  it('repairs doubled single-quote wrappers around colon-containing list scalars', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'api_contracts:',
      "  - ''Response includes Content-Disposition: attachment; filename=synonyms.json''",
    ].join('\n'), { repairWarnings }) as {
      api_contracts: string[]
    }

    expect(repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(parsed.api_contracts).toEqual([
      'Response includes Content-Disposition: attachment; filename=synonyms.json',
    ])
  })

  it('recovers combined quoted-scalar and colon-scalar near misses in one pass', () => {
    const command = 'node -e "const fs=require(\'fs\');console.error(\'Missing pink tokens: \'+[\'accent\'].join(\',\'))"'
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'beads:',
      '  - id: bead-1',
      '    title: Preserve visible text across combined parser repairs',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Recover multiple safe YAML near-misses without changing their meaning.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      "      - 'pink' is accepted as a valid theme value in UIState.",
      '      - Parser preserves the original visible scalar text.',
      '    tests:',
      '      - Combined parser regression covers malformed quoted list items plus command scalars.',
      '    testCommands:',
      `      - ${command}`,
    ].join('\n'), { repairWarnings }) as {
      beads: Array<{
        acceptanceCriteria: string[]
        testCommands: string[]
      }>
    }

    expect(repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(parsed.beads[0]?.acceptanceCriteria).toEqual([
      '\'pink\' is accepted as a valid theme value in UIState.',
      'Parser preserves the original visible scalar text.',
    ])
    expect(parsed.beads[0]?.testCommands).toEqual([command])
  })

  it('recovers quoted block-scalar indicators while preserving the emitted body text', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
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
      '      - Structured output parser covers the malformed indicator.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'), { repairWarnings }) as {
      beads: Array<{
        description: string
      }>
    }

    expect(repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(parsed.beads[0]?.description).toBe([
      'Edit ui/src/scss/_vars.scss and replace the default token.',
      'Preserve the emitted body text exactly.',
    ].join('\n'))
  })

  it('repairs inner double quotes inside one-line scalars before parsing', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'questions:',
      '  - id: Q06',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "Errors must include `origin: "date"`, `minimum`, and `maximum` metadata."',
    ].join('\n'), { repairWarnings }) as {
      questions: Array<{ answer: { free_text: string } }>
    }

    expect(repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(parsed.questions[0]?.answer.free_text).toBe('Errors must include `origin: "date"`, `minimum`, and `maximum` metadata.')
  })

  it('repairs unclosed quoted list items before parsing', () => {
    const repairWarnings: string[] = []

    const parsed = parseYamlOrJsonCandidate([
      'scope:',
      '  out_of_scope:',
      '    - "Integration with other date helpers beyond min/max',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - Must extend the existing date schema interface',
    ].join('\n'), { repairWarnings }) as {
      scope: { out_of_scope: string[] }
      technical_requirements: { architecture_constraints: string[] }
    }

    expect(repairWarnings).toContain('Fixed unbalanced YAML quote before reparsing.')
    expect(parsed.scope.out_of_scope).toEqual(['Integration with other date helpers beyond min/max'])
    expect(parsed.technical_requirements.architecture_constraints).toEqual([
      'Must extend the existing date schema interface',
    ])
  })
})

describe.concurrent('getValueByAliases', () => {
  it('matches snake_case aliases against normalized object keys', () => {
    expect(getValueByAliases({
      change_type: 'modified',
      itemType: 'user_story',
      source_interview: 'hash',
    }, ['change_type'])).toBe('modified')
    expect(getValueByAliases({
      change_type: 'modified',
      itemType: 'user_story',
      source_interview: 'hash',
    }, ['item_type'])).toBe('user_story')
    expect(getValueByAliases({
      change_type: 'modified',
      itemType: 'user_story',
      source_interview: 'hash',
    }, ['sourceInterview'])).toBe('hash')
  })
})
