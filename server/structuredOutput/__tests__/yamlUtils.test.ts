import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildStructuredRetryPrompt, getValueByAliases, parseYamlOrJsonCandidate, REPAIR_PIPELINE_VERSION } from '../yamlUtils'

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
  it('preserves a flow-body string while repairing an unrelated duplicate key', () => {
    const body = [
      'body: [',
      '  "hello',
      '  x: same',
      '  x: same',
      '  x: same',
      '  world"',
      '  ]',
    ].join('\n')
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate(`${body}\ntitle: same\ntitle: same`, { repairWarnings }) as {
      body: string[]
      title: string
    }
    const expectedBody = (parseYamlOrJsonCandidate(body) as { body: string[] }).body

    expect(parsed.body).toEqual(expectedBody)
    expect(parsed.body[0]).toContain('x: same x: same x: same')
    expect(parsed.title).toBe('same')
    expect(repairWarnings).toContain('Removed duplicate YAML mapping keys before parsing.')
  })

  it('keeps the cache marker tied to both complete parser sources', () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const normalizeVersionDeclaration = (source: string) => source.replace(
      /export const REPAIR_PIPELINE_VERSION = '[^']+'/,
      "export const REPAIR_PIPELINE_VERSION = '<source-version>'",
    )
    const source = [
      readFileSync(resolve(repositoryRoot, 'shared/yamlRepair.ts'), 'utf8'),
      readFileSync(resolve(repositoryRoot, 'server/structuredOutput/yamlUtils.ts'), 'utf8'),
    ].map(normalizeVersionDeclaration)
    const expectedVersion = createHash('sha256').update(JSON.stringify(source)).digest('hex')

    expect(REPAIR_PIPELINE_VERSION).toBe(expectedVersion)
  })

  it.each([
    ['[EPIC-1, US-1]', ['EPIC-1', 'US-1']],
    ["['alpha', 'beta']", ['alpha', 'beta']],
    ['{owner: model}', { owner: 'model' }],
    ['[one, two,]', ['one', 'two']],
    ["[don't]", ["don't"]],
    ["{name: Bob's}", { name: "Bob's" }],
  ])('repairs duplicates and nested mappings beside closed YAML flow %s', (flow, refs) => {
    const repairWarnings: string[] = []
    const input = `refs: ${flow}\nparent:\nfirst: 1\nname: same\nname: same\n\nnext: 9`

    expect(parseYamlOrJsonCandidate(input, {
      nestedMappingChildren: { parent: ['first'] }, repairWarnings,
    })).toEqual({ refs, parent: { first: 1 }, name: 'same', next: 9 })
    expect(repairWarnings).toContain('Removed duplicate YAML mapping keys before parsing.')
  })

  it.each(['t: |\n  one\n# c\n  two', 't: foo [\n  a\n]', 't: foo {\n  a: b\n}'])(
    'rejects both malformed duplicate entries without reporting partial removal: %s', (entry) => {
      const repairWarnings: string[] = []

      expect(() => parseYamlOrJsonCandidate(`${entry}\n${entry}\nz: 9`, { repairWarnings })).toThrow()
      expect(repairWarnings).not.toContain('Removed duplicate YAML mapping keys before parsing.')
    },
  )

  it.each([
    ['block scalar', 't: |\n  one\nt: |\n  two'],
    ['nested mapping', 'options:\n  value: one\noptions:\n  value: two'],
    ['nested list', 'options:\n  - one\noptions:\n  - two'],
    ['indentless list', 'options:\n- one\noptions:\n- two'],
    ['plain multiline value', 't: first\n  one\nt: first\n  two'],
  ])('rejects conflicting duplicate %s values through the full repair cascade', (_, input) => {
    const repairWarnings: string[] = []

    expect(() => parseYamlOrJsonCandidate(input, { repairWarnings })).toThrow()
    expect(repairWarnings).not.toContain('Removed duplicate YAML mapping keys before parsing.')
  })

  it('removes complete duplicates even when another mapping has an anchor', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'title: first',
      'title: first',
      'anchored: &value retained',
      'other: second',
      'other: second',
    ].join('\n'), { repairWarnings }) as Record<string, unknown>

    expect(parsed).toEqual({ title: 'first', anchored: 'retained', other: 'second' })
    expect(repairWarnings).toContain('Removed duplicate YAML mapping keys before parsing.')
  })

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

  it('preserves a valid nested sequence when raw YAML parses successfully', () => {
    expect(parseYamlOrJsonCandidate("items:\n  - - 'a: b'\n")).toEqual({ items: [['a: b']] })
  })

  it('keeps a nested sequence intact when a sibling still needs repair', () => {
    const repairWarnings: string[] = []
    expect(parseYamlOrJsonCandidate([
      "items:",
      "  - - 'a: b'",
      '  -id: second',
      '    title: Second item',
    ].join('\n'), { repairWarnings })).toEqual({
      items: [['a: b'], { id: 'second', title: 'Second item' }],
    })
    expect(repairWarnings).toContain('Inserted the missing space after a YAML list dash before parsing.')
  })

  it('keeps explicit nested mapping recovery ahead of the raw YAML parse', () => {
    expect(parseYamlOrJsonCandidate([
      'summary:',
      'goals:',
      '  - one',
    ].join('\n'), {
      nestedMappingChildren: { summary: ['goals'] },
    })).toEqual({ summary: { goals: ['one'] } })
  })

  it('normalizes CRLF before applying line-based repairs and cache keys', () => {
    const repairWarnings: string[] = []
    expect(parseYamlOrJsonCandidate('title: Fix parser: handle colons\r\nnext: ok\r\n', { repairWarnings })).toEqual({
      title: 'Fix parser: handle colons',
      next: 'ok',
    })
    expect(repairWarnings).toContain('Quoted YAML plain scalar values containing colon-space before reparsing.')
  })

  it('preserves XML-looking lines inside a block scalar and warns only for removed tags', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'owner: @loop-troop',
      '<metadata>',
      'snippet: |',
      '  <div>',
      '  hello',
      '  </div>',
    ].join('\n'), { repairWarnings }) as { owner: string; snippet: string }

    expect(parsed.snippet).toBe('<div>\nhello\n</div>\n')
    expect(repairWarnings).toContain('Stripped XML-style tags <metadata> from the payload before parsing.')
    expect(repairWarnings.join('\n')).not.toContain('<div>')
    expect(repairWarnings.join('\n')).not.toContain('</div>')
  })

  it('preserves literal content in a compact nested sequence block scalar', () => {
    expect(parseYamlOrJsonCandidate([
      'owner: @team',
      'items:',
      '  - - |',
      '      <div>',
      '      hello',
      '      </div>',
    ].join('\n'))).toEqual({
      owner: '@team',
      items: [['<div>\nhello\n</div>\n']],
    })
  })

  it('preserves literal content in a standalone block scalar', () => {
    expect(parseYamlOrJsonCandidate([
      'owner: @team',
      'body:',
      '  |',
      '    x: same',
      '    x: same',
    ].join('\n'))).toEqual({
      owner: '@team',
      body: 'x: same\nx: same\n',
    })
  })

  it('converts only non-string free text while preserving a valid folded answer', () => {
    const parsed = parseYamlOrJsonCandidate([
      'free_text: false',
      'other:',
      '  free_text: first',
      '    second',
    ].join('\n')) as { free_text: string; other: { free_text: string } }

    expect(parsed.free_text).toBe('false')
    expect(parsed.other.free_text).toBe('first second')
  })

  it('keeps a valid folded free_text value when an unrelated sibling needs repair', () => {
    expect(parseYamlOrJsonCandidate([
      'owner: @team',
      'answer:',
      '  free_text: first',
      '    second',
    ].join('\n'))).toEqual({
      owner: '@team',
      answer: { free_text: 'first second' },
    })
  })

  it.each([false, true])('preserves distinct canonical and alias answers (alias first: %s)', (aliasFirst) => {
    const entries = ['free_text: canonical answer', 'freeText: alias answer']
    if (aliasFirst) entries.reverse()
    const parsed = parseYamlOrJsonCandidate([...entries, 'other:', '  free_text: false'].join('\n'))
    expect(parsed).toEqual({ free_text: 'canonical answer', freeText: 'alias answer', other: { free_text: 'false' } })
  })

  it('does not strip text that only resembles an XML tag', () => {
    const repairWarnings: string[] = []
    expect(() => parseYamlOrJsonCandidate([
      '< metadata>',
      'title: keep this text',
    ].join('\n'), { repairWarnings })).toThrow()
    expect(repairWarnings.join('\n')).not.toContain('Stripped XML-style tags')
  })

  it('uses the mapping key column as the block base for list-item scalar siblings', () => {
    const repairWarnings: string[] = []
    expect(parseYamlOrJsonCandidate([
      'items:',
      '  - body: |',
      '      text',
      '    owner: @loop-troop',
    ].join('\n'), { repairWarnings })).toEqual({
      items: [{ body: 'text\n', owner: '@loop-troop' }],
    })
    expect(repairWarnings).toContain('Quoted plain YAML scalars that began with reserved indicator characters (` or @) before reparsing.')
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

  it.each(['  -  Content-Disposition: attachment; filename=synonyms.json', '  -\tContent-Disposition: attachment; filename=synonyms.json'])(
    'recognizes header-like list scalars after dash whitespace: %s',
    (line) => {
      const repairWarnings: string[] = []
      const parsed = parseYamlOrJsonCandidate(`api_contracts:\n${line}`, { repairWarnings }) as {
        api_contracts: string[]
      }

      expect(parsed.api_contracts).toEqual(['Content-Disposition: attachment; filename=synonyms.json'])
      expect(repairWarnings).toContain('Quoted YAML plain scalar values containing colon-space before reparsing.')
    },
  )

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

describe.concurrent('cached candidate parsing', () => {
  it('keeps deeply nested valid JSON parseable on repeated calls', () => {
    // Depending on the Node/V8 stack budget, these exercise a cache hit,
    // serialization bypass, or successful serialization followed by a failed read.
    for (const depth of [2000, 3000, 4000]) {
      const content = `${'{"child":'.repeat(depth)}null${'}'.repeat(depth)}`
      for (let call = 0; call < 2; call++) {
        let value = parseYamlOrJsonCandidate(content)
        for (let level = 0; level < depth; level++) value = (value as { child: unknown }).child
        expect(value).toBeNull()
      }
    }
  })

  it('bypasses unkeyable repair options without rejecting valid JSON', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const nestedMappingChildren of [circular, { answer: 1n }]) {
      const options = { nestedMappingChildren } as Parameters<typeof parseYamlOrJsonCandidate>[1]
      expect(parseYamlOrJsonCandidate('{"key_fallback":true}', options)).toEqual({ key_fallback: true })
    }
  })

  it('preserves option order when normalized parent names collide', () => {
    const content = 'parent:\nfirst: 1'
    expect(parseYamlOrJsonCandidate(content, {
      nestedMappingChildren: { PARENT: ['first'], parent: ['second'] },
    })).toEqual({ parent: null, first: 1 })
    expect(parseYamlOrJsonCandidate(content, {
      nestedMappingChildren: { parent: ['second'], PARENT: ['first'] },
    })).toEqual({ parent: { first: 1 } })
  })

  it('keeps distinct lone UTF-16 surrogates in JSON strings separate', () => {
    for (const code of [0xd800, 0xd801, 0xfffd]) {
      const value = String.fromCharCode(code)
      const content = `"${value}"`
      expect(parseYamlOrJsonCandidate(content)).toBe(value)
      expect(parseYamlOrJsonCandidate(content)).toBe(value)
    }
  })

  it('replays repairs even if the first caller did not request warnings', () => {
    const content = 'items:\n  -id: cache-one\n  -id: cache-two'
    const first = parseYamlOrJsonCandidate(content) as { items: { id: string }[] }
    first.items[0]!.id = 'caller edit'
    const repairWarnings = ['existing warning']
    const second = parseYamlOrJsonCandidate(content, { repairWarnings })
    expect(second).toEqual({ items: [{ id: 'cache-one' }, { id: 'cache-two' }] })
    expect(repairWarnings).toEqual([
      'existing warning',
      'Inserted the missing space after a YAML list dash before parsing.',
    ])
    parseYamlOrJsonCandidate(content, { repairWarnings })
    expect(repairWarnings).toHaveLength(2)
    repairWarnings.push('caller-specific warning')
    const nextWarnings: string[] = []
    parseYamlOrJsonCandidate(content, { repairWarnings: nextWarnings })
    expect(nextWarnings).toEqual(['Inserted the missing space after a YAML list dash before parsing.'])
  })

  it('separates nested-mapping repair settings in both call orders', () => {
    for (const child of ['first', 'second']) {
      const content = `answer:\n${child}: true`
      const options = { nestedMappingChildren: { answer: [child] } }
      if (child === 'first') parseYamlOrJsonCandidate(content)
      expect(parseYamlOrJsonCandidate(content, options)).toEqual({ answer: { [child]: true } })
      expect(parseYamlOrJsonCandidate(content)).toEqual({ answer: null, [child]: true })
      expect(parseYamlOrJsonCandidate(content, options)).toEqual({ answer: { [child]: true } })
    }
  })

  it('separates every primary-key repair option and never reuses an opt-in for other callers', () => {
    const content = 'beads:\n  - cache-bead\n    title: Cache test'
    const options = { sequenceItemPrimaryKeys: { beads: { primaryKey: 'id', childKeys: ['title'] } } }
    expect(() => parseYamlOrJsonCandidate(content)).toThrow()
    expect(parseYamlOrJsonCandidate(content, options)).toEqual({ beads: [{ id: 'cache-bead', title: 'Cache test' }] })
    options.sequenceItemPrimaryKeys.beads.primaryKey = 'slug'
    expect(parseYamlOrJsonCandidate(content, options)).toEqual({ beads: [{ slug: 'cache-bead', title: 'Cache test' }] })
    options.sequenceItemPrimaryKeys.beads.childKeys = ['description']
    expect(() => parseYamlOrJsonCandidate(content, options)).toThrow()
    expect(() => parseYamlOrJsonCandidate(content)).toThrow()
  })

  it('keeps terminal-noise recovery opt-in after a successful repair', () => {
    const content = '{"cache_noise":true}\u001b[0m'
    expect(parseYamlOrJsonCandidate(content, { allowTrailingTerminalNoise: true })).toEqual({ cache_noise: true })
    expect(() => parseYamlOrJsonCandidate(content)).toThrow()
    expect(() => parseYamlOrJsonCandidate(content, { allowTrailingTerminalNoise: false })).toThrow()
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
