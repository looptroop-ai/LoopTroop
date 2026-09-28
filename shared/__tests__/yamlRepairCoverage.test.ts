import { describe, expect, it } from 'vitest'
import * as jsYaml from 'js-yaml'
import {
  repairYamlDoubleQuotedInvalidEscapes,
  repairYamlFreeTextScalars,
  repairYamlIndentation,
  repairYamlInlineKeys,
  repairYamlMappingKeyColonSpace,
  repairYamlNestedMappingChildren,
  repairYamlWrappedPlainListScalars,
} from '../yamlRepair'

describe('yaml repair coverage gaps', () => {
  it('keeps blank paragraphs and sibling fields when repairing malformed free-text blocks', () => {
    const input = [
      'answer:',
      '  free_text: >-',
      'First malformed line.',
      '',
      'Second malformed line.',
      '  answered_by: user_skip',
      'summary:',
      '  goals:',
      '    - Keep context private.',
    ].join('\n')

    const repaired = repairYamlFreeTextScalars(input)
    const parsed = jsYaml.load(repaired) as {
      answer: { free_text: string; answered_by: string }
      summary: { goals: string[] }
    }

    expect(parsed).toEqual({
      answer: {
        free_text: 'First malformed line.\nSecond malformed line.',
        answered_by: 'user_skip',
      },
      summary: { goals: ['Keep context private.'] },
    })
  })

  it('preserves blank continuation lines and stops at a following YAML section', () => {
    const input = [
      'answer:',
      '  free_text: First line',
      '    continuation one',
      '',
      '    continuation two',
      'summary:',
      '  goals:',
      '    - Keep context private.',
    ].join('\n')

    const repaired = repairYamlFreeTextScalars(input)
    const parsed = jsYaml.load(repaired) as {
      answer: { free_text: string }
      summary: { goals: string[] }
    }

    expect(parsed.answer.free_text).toBe('First line\ncontinuation one\n\ncontinuation two')
    expect(parsed.summary.goals).toEqual(['Keep context private.'])
  })

  it('splits inline scalar sequences without breaking on quoted dash text', () => {
    const input = String.raw`values: - "quoted - part" - 'owner''s choice' - "escaped \"dash - value\"" done: true`

    const repaired = repairYamlInlineKeys(input)

    expect(jsYaml.load(repaired)).toEqual({
      values: ['quoted - part', "owner's choice", 'escaped "dash - value"'],
      done: true,
    })
  })

  it('leaves wrapped list prose unchanged when a blank continuation makes folding ambiguous', () => {
    const input = [
      'items:',
      '  - Plain prose reports value: false, and',
      '    continued line one',
      '',
      '    continued line two',
    ].join('\n')

    expect(repairYamlWrappedPlainListScalars(input)).toBe(input)
  })

  it('keeps valid Unicode escapes and repairs malformed escapes without changing quoted text', () => {
    const input = String.raw`values:
  valid: "\U0001F600"
  invalid: "\U0000G000"
  partial: "\xG1"
  single: 'model''s \q'`
    const repaired = repairYamlDoubleQuotedInvalidEscapes(input)

    expect(repaired).toBe(String.raw`values:
  valid: "\U0001F600"
  invalid: "\\U0000G000"
  partial: "\\xG1"
  single: 'model''s \q'`)
    expect(jsYaml.load(repaired)).toEqual({
      values: {
        valid: '😀',
        invalid: '\\U0000G000',
        partial: '\\xG1',
        single: "model's \\q",
      },
    })
  })

  it('repairs a misindented nested mapping without flattening its child', () => {
    const input = ['items:', '  - id: task-one', '   title:', '      label: name'].join('\n')

    expect(repairYamlIndentation(input)).toBe([
      'items:',
      '  - id: task-one',
      '    title:',
      '      label: name',
    ].join('\n'))
  })

  it('keeps nested mapping repair bounded by comments, non-mappings, and document separators', () => {
    const children = { metadata: ['winner_model', 'generated_at'] }
    const cases = [
      'metadata: winner_model\n\n# skip this comment\n    nested: value\nunknown: value',
      '  metadata: winner_model\n  - scalar item',
      'metadata: winner_model\n# no following sibling',
    ]
    for (const input of cases) expect(repairYamlNestedMappingChildren(input, children)).toBe(input)

    expect(repairYamlNestedMappingChildren('metadata:\n', { unused: [] })).toBe('metadata:\n')

    const document = ['metadata:', 'winner_model:', '', '# still inside the child block', '---', 'next: value'].join('\n')
    expect(repairYamlNestedMappingChildren(document, { metadata: ['winner_model'] })).toBe([
      'metadata:',
      '  winner_model:',
      '',
      '# still inside the child block',
      '---',
      'next: value',
    ].join('\n'))
  })

  it('sets block-scalar context after repairing a mapping colon', () => {
    const input = ['body:|', '  key: value', 'next:ok'].join('\n')

    expect(repairYamlMappingKeyColonSpace(input)).toBe([
      'body: |',
      '  key: value',
      'next: ok',
    ].join('\n'))
  })
})
