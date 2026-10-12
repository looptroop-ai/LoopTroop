import { describe, expect, it, vi } from 'vitest'
import * as executionLog from '../../../log/executionLog'
import { broadcaster } from '../../../sse/broadcaster'
import {
  buildBeadLogFields,
  emitDebugLog,
  emitPhaseLog,
  formatStreamEventDuration,
  formatTimestamp,
  normalizeAttachmentMetadata,
  stringifyForLog,
  stringifyToolDetail,
} from '../logEmission'

describe('DEBUG emission privacy', () => {
  it.each(['PRE_FLIGHT_CHECK', 'CODING', 'COUNCIL_DELIBERATING'] as const)('sanitizes %s debug message and payload before live truncation or persistence', (phase) => {
    const append = vi.spyOn(executionLog, 'appendLogEvent').mockImplementation(() => {})
    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => {})
    const payload = {
      entryId: 'entry-real', sessionId: 'ses-real', modelId: 'openai/model-real', phaseAttempt: 2,
      cursor: 'cursor-real', startToken: 'process-real', inputToken: 12, hasCredentials: false,
      headers: { authorization: 'logger-header-secret', cookie: 'first=logger-cookie-secret; second=logger-other-cookie-secret' },
      response: '{"apiKey":"logger-body-secret","message":"Keep the cause."}',
      evidence: 'e'.repeat(9000),
    }
    const original = JSON.stringify(payload)
    try {
      emitDebugLog('1:T-logger', phase, `${'m'.repeat(7980)} Authorization: Bearer logger-message-secret`, payload)
      expect(append).toHaveBeenCalledTimes(1)
      const persistedMessage = append.mock.calls[0]?.[3] ?? ''
      const persistedData = append.mock.calls[0]?.[4]
      const live = broadcast.mock.calls[0]?.[2]
      for (const evidence of [persistedMessage, JSON.stringify(persistedData), JSON.stringify(live)]) {
        expect(evidence).not.toMatch(/logger-(?:header|cookie|other-cookie|body|message)-secret/)
      }
      expect(persistedMessage.length).toBeGreaterThan(10_000)
      expect(live?.content).toContain('debug payload truncated for live stream')
      expect(persistedData).toMatchObject({
        ...payload,
        headers: { authorization: '[redacted]', cookie: '[redacted]' },
        response: '{"apiKey":"[redacted]","message":"Keep the cause."}',
      })
      expect(live?.data).toEqual(persistedData)
      expect(JSON.stringify(payload)).toBe(original)
    } finally {
      append.mockRestore()
      broadcast.mockRestore()
    }
  })

  it.each(['type', 'source', 'audience'] as const)('sanitizes direct DEBUG records classified by %s', (route) => {
    const append = vi.spyOn(executionLog, 'appendLogEvent').mockImplementation(() => {})
    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => {})
    const metadata = {
      phaseAttempt: 2, entryId: `entry-${route}`, fingerprint: `fingerprint-${route}`,
      cursor: 'cursor-real', startToken: 'process-real', inputToken: 12,
      variant: 'Authorization: Bearer logger-route-variant-secret',
      ...(route === 'source' ? { source: 'debug' } : {}),
      ...(route === 'audience' ? { audience: 'debug', source: 'error' } : {}),
      authorization: 'logger-route-header-secret',
    }
    try {
      emitPhaseLog('1:T-logger', 'T-logger', 'CODING', route === 'type' ? 'debug' : 'error', 'Authorization: Bearer logger-route-secret', metadata)
      const persisted = append.mock.calls[0]
      expect(persisted?.[3]).toBe('Authorization: [redacted]')
      expect(persisted?.[4]).toMatchObject({ ...metadata, authorization: '[redacted]', variant: 'Authorization: [redacted]' })
      expect(persisted?.[7]).toMatchObject({ entryId: metadata.entryId, fingerprint: metadata.fingerprint, phaseAttempt: 2, variant: 'Authorization: [redacted]' })
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain('logger-route-secret')
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain('logger-route-header-secret')
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain('logger-route-variant-secret')
      expect(metadata.authorization).toBe('logger-route-header-secret')
    } finally {
      append.mockRestore()
      broadcast.mockRestore()
    }
  })

  it('preserves ordinary AI content while sanitizing its non-persisted DEBUG mirror', () => {
    const append = vi.spyOn(executionLog, 'appendLogEvent').mockImplementation(() => {})
    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => {})
    const content = `const password = ${JSON.stringify('logger-ai-secret')}; https://docs.example/search?q=example#section`
    try {
      emitPhaseLog('1:T-logger', 'T-logger', 'CODING', 'model_output', content, { audience: 'ai', phaseAttempt: 2 })
      expect(append).toHaveBeenCalledTimes(1)
      expect(append.mock.calls[0]?.[3]).toBe(content)
      expect(broadcast.mock.calls[0]?.[2].content).toBe(content)
      const mirror = broadcast.mock.calls.find(([, , event]) => event.type === 'debug')?.[2]
      expect(mirror?.content).toContain('[redacted]')
      expect(JSON.stringify(mirror)).not.toContain('logger-ai-secret')
      expect(JSON.stringify(mirror)).not.toContain('?q=example')
    } finally {
      append.mockRestore()
      broadcast.mockRestore()
    }
  })
})

/**
 * The value formatters behind every log line a phase emits.
 *
 * They came out of a 2,337-line `helpers.ts` in PR-13 with no direct coverage:
 * what they produce reaches the log file, the live stream and the interface,
 * and every one of them is on the path of a stream event, so a throw here takes
 * a run down rather than losing a line.
 */
describe('stringifyForLog', () => {
  it('passes a string through untouched, including its whitespace', () => {
    expect(stringifyForLog('  spaced  \n')).toBe('  spaced  \n')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('renders %s as an empty string rather than the word', (_, value) => {
    expect(stringifyForLog(value)).toBe('')
  })

  it('serialises an object compactly', () => {
    expect(stringifyForLog({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}')
  })

  it('falls back to String() for a value JSON cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(stringifyForLog(circular)).toBe('[object Object]')
  })

  it('does not swallow a bigint, which JSON.stringify throws on', () => {
    expect(stringifyForLog(10n)).toBe('10')
  })
})

describe('stringifyToolDetail', () => {
  it('trims trailing whitespace from a string but keeps leading indentation', () => {
    expect(stringifyToolDetail('  body  \n\n', 100)).toBe('  body')
  })

  it('serialises an object with indentation, unlike the log formatter', () => {
    expect(stringifyToolDetail({ a: 1 }, 100)).toBe('{\n  "a": 1\n}')
  })

  it('says how much it truncated, in characters', () => {
    expect(stringifyToolDetail('abcdefghij', 4)).toBe('abcd\n… (truncated 6 chars)')
  })

  it('leaves a value of exactly the limit alone', () => {
    expect(stringifyToolDetail('abcd', 4)).toBe('abcd')
  })

  it('truncates a serialised object too, not just a string', () => {
    const detail = stringifyToolDetail({ key: 'x'.repeat(200) }, 20)

    expect(detail).toHaveLength(20 + '\n… (truncated 195 chars)'.length)
    expect(detail).toContain('… (truncated')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('renders %s as an empty string', (_, value) => {
    expect(stringifyToolDetail(value, 100)).toBe('')
  })
})

describe('normalizeAttachmentMetadata', () => {
  it('collapses every run of whitespace into one space', () => {
    expect(normalizeAttachmentMetadata('a \n\t b  c', 100)).toBe('a b c')
  })

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n  '],
    ['undefined', undefined],
  ])('returns undefined for %s, so the field is omitted rather than blank', (_, value) => {
    expect(normalizeAttachmentMetadata(value, 100)).toBeUndefined()
  })

  it('marks a truncated value with an ellipsis, not with a character count', () => {
    // Unlike the tool detail above: this one goes in a metadata field, where a
    // sentence about truncation would be read as part of the value.
    expect(normalizeAttachmentMetadata('abcdefghij', 4)).toBe('abcd…')
  })

  it('leaves a value of exactly the limit alone', () => {
    expect(normalizeAttachmentMetadata('abcd', 4)).toBe('abcd')
  })
})

describe('formatStreamEventDuration', () => {
  it.each([
    [0, '0ms'],
    [840, '840ms'],
    [840.6, '841ms'],
    [999, '999ms'],
    [1000, '1.00s'],
    [2350, '2.35s'],
    [9999, '10.00s'],
    [10_000, '10.0s'],
    [59_999, '60.0s'],
    [60_000, '1m 0s'],
    [90_000, '1m 30s'],
    [3_600_000, '60m 0s'],
  ])('renders %ims as %s', (input, expected) => {
    expect(formatStreamEventDuration(input)).toBe(expected)
  })

  it('is not the same rendering as phaseRuntimeSettings.formatDurationMs', async () => {
    // Two public `formatDuration…` functions that disagree is the trap the
    // split left behind; this pins that they are deliberately different.
    const { formatDurationMs } = await import('../phaseRuntimeSettings')

    expect(formatStreamEventDuration(90_000)).toBe('1m 30s')
    expect(formatDurationMs(90_000)).not.toBe(formatStreamEventDuration(90_000))
  })
})

describe('formatTimestamp', () => {
  it('renders an epoch millisecond value as an ISO string', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00.000Z')
  })

  it('echoes a value that is not a date rather than emitting "Invalid Date"', () => {
    expect(formatTimestamp(Number.NaN)).toBe('NaN')
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('Infinity')
  })
})

describe('buildBeadLogFields', () => {
  it('omits both fields when there is no bead', () => {
    expect(buildBeadLogFields()).toEqual({})
  })

  it('omits the iteration when it is not a finite number', () => {
    // The fields are spread into a structured log record, so a present-but-
    // undefined key is a different record from an absent one.
    expect(buildBeadLogFields('bead-1', Number.NaN)).toEqual({ beadId: 'bead-1' })
    expect(buildBeadLogFields('bead-1', Number.POSITIVE_INFINITY)).toEqual({ beadId: 'bead-1' })
    expect(buildBeadLogFields('bead-1')).toEqual({ beadId: 'bead-1' })
  })

  it('keeps iteration zero, which is falsy but real', () => {
    expect(buildBeadLogFields('bead-1', 0)).toEqual({ beadId: 'bead-1', beadIteration: 0 })
  })

  it('omits the bead id when it is empty', () => {
    expect(buildBeadLogFields('', 2)).toEqual({ beadIteration: 2 })
  })
})
