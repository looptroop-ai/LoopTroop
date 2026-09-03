import { describe, expect, it } from 'vitest'
import { parseCompletionMarker } from '../completionChecker'
import { BEAD_STATUS_END, BEAD_STATUS_MARKER } from '../completionSchema'

function buildMarker(payload: Record<string, unknown>): string {
  return `${BEAD_STATUS_MARKER}${JSON.stringify(payload)}${BEAD_STATUS_END}`
}

const passingChecks = { tests: 'pass', lint: 'pass', typecheck: 'pass', qualitative: 'pass' }

describe('parseCompletionMarker', () => {
  it('accepts a marker for the running bead', () => {
    const result = parseCompletionMarker(
      buildMarker({ bead_id: 'bead-1', status: 'done', checks: passingChecks }),
      'bead-1',
    )

    expect(result).toMatchObject({ complete: true, markerFound: true, gatesValid: true, beadId: 'bead-1' })
  })

  it('rejects a marker that names a different bead', () => {
    const result = parseCompletionMarker(
      buildMarker({ bead_id: 'bead-9', status: 'done', checks: passingChecks }),
      'bead-1',
    )

    expect(result.complete).toBe(false)
    expect(result.markerFound).toBe(true)
    expect(result.validationError).toContain('bead-9')
    expect(result.validationError).toContain('bead-1')
  })

  it('still parses without an expected bead id', () => {
    const result = parseCompletionMarker(
      buildMarker({ bead_id: 'bead-9', status: 'done', checks: passingChecks }),
    )

    expect(result.complete).toBe(true)
  })

  it('reports markerFound false when the tags are absent', () => {
    const result = parseCompletionMarker('I finished the work.', 'bead-1')

    expect(result.markerFound).toBe(false)
  })

  it('reports markerFound true when the tags are present but the payload is invalid', () => {
    const result = parseCompletionMarker(
      `${BEAD_STATUS_MARKER}{"status":"done"}${BEAD_STATUS_END}`,
      'bead-1',
    )

    expect(result.markerFound).toBe(true)
    expect(result.complete).toBe(false)
  })

  it('reports markerFound false when only the opening tag is present', () => {
    const truncated = `${BEAD_STATUS_MARKER}{"bead_id":"bead-1","status":"done"`

    expect(parseCompletionMarker(truncated, 'bead-1').markerFound).toBe(false)
  })

  it('reports markerFound false for a prompt echo, which used to read as present', () => {
    // markerFound was inferred from the error text, so any validation error that
    // was not the missing-marker message read as proof the marker was there.
    // A prompt echo replaces that message, so it used to report markerFound.
    const echo = [
      'CRITICAL OUTPUT RULE:',
      '## Task',
      'Report the bead status when the work is done.',
    ].join('\n')

    const result = parseCompletionMarker(echo, 'bead-1')
    expect(result.errors[0]).toMatch(/echoed the prompt/i)
    expect(result.markerFound).toBe(false)
  })
})
