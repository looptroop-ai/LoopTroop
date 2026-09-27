import { describe, expect, it } from 'vitest'
import { validateRelevantFilesScanResponse } from '../phases/verificationPhase'

describe('verification phase response validation', () => {
  it('rejects empty output before attempting to count protocol tags', () => {
    const result = validateRelevantFilesScanResponse('  ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Relevant files output was empty.')
  })

  it('uses a valid structured fallback without exact protocol tags', () => {
    const result = validateRelevantFilesScanResponse([
      'file_count: 1',
      'files:',
      '  - path: src/main.ts',
      '    reason: Application entry point.',
      '    action: modify',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.files).toEqual([expect.objectContaining({
      path: 'src/main.ts',
      rationale: 'Application entry point.',
      likely_action: 'modify',
    })])
  })

  it('preserves the prompt-echo diagnostic instead of replacing it with tag counts', () => {
    const response = [
      'CRITICAL OUTPUT RULE:',
      'Return strict machine-readable output.',
      '',
      'CONTEXT REFRESH:',
      'Use the latest ticket context.',
      '',
      '## System Role',
      'You are a software architect.',
    ].join('\n')

    const result = validateRelevantFilesScanResponse(response)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('echoed the prompt')
      expect(result.error).not.toContain('found open=0, close=0')
    }
  })

  it('reports duplicate protocol blocks when no structured candidate is valid', () => {
    const block = '<RELEVANT_FILES_RESULT>not a mapping</RELEVANT_FILES_RESULT>'
    const result = validateRelevantFilesScanResponse(`${block}\n${block}`)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('found open=2, close=2')
  })

  it('returns the normalizer error when exactly one protocol block is malformed', () => {
    const result = validateRelevantFilesScanResponse(
      '<RELEVANT_FILES_RESULT>not a mapping</RELEVANT_FILES_RESULT>',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('exactly one')
      expect(result.error).toContain('Relevant files output')
    }
  })

  it('reports the missing protocol block when the response has no tags', () => {
    const response = 'This is not a relevant-files artifact.'

    const result = validateRelevantFilesScanResponse(response)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(
        'Relevant files output must contain exactly one <RELEVANT_FILES_RESULT>...</RELEVANT_FILES_RESULT> block (found open=0, close=0).',
      )
      expect(result.error).toContain('Relevant files output is not a YAML/JSON object')
    }
  })
})
