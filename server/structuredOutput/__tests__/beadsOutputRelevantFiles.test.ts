import { describe, expect, it } from 'vitest'
import { normalizeRelevantFilesOutput } from '../beadsOutput'

describe('relevant files output parsing failures', () => {
  it('reports repair when parser-only indentation recovery is needed', () => {
    const result = normalizeRelevantFilesOutput([
      'file_count: 1',
      'files:',
      '  - path: src/app.ts',
      '   rationale: Entry point.',
      '   relevance: high',
    ].join('\n'))

    expect(result.ok, result.ok ? undefined : result.error).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.files).toEqual([{
      path: 'src/app.ts',
      rationale: 'Entry point.',
      relevance: 'high',
      likely_action: 'read',
      content: '',
      content_preview: '',
    }])
  })

  it.each([
    [
      'one incomplete entry',
      [
        'files:',
        '  - path: [unfinished',
      ].join('\n'),
    ],
    [
      'a malformed earlier entry before a truncated entry',
      [
        'files:',
        '  - path: [unfinished',
        '    rationale: This entry is invalid.',
        '  - path: src/truncated.ts',
        '    rationale: This entry is incomplete.',
      ].join('\n'),
    ],
  ])('rejects %s without returning partial file data', (_label, rawContent) => {
    const result = normalizeRelevantFilesOutput(rawContent)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeTruthy()
    expect(result).not.toHaveProperty('value')
  })
})
