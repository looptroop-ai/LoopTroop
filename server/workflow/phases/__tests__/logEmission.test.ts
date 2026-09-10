import { describe, expect, it } from 'vitest'
import {
  buildBeadLogFields,
  formatStreamEventDuration,
  formatTimestamp,
  normalizeAttachmentMetadata,
  stringifyForLog,
  stringifyToolDetail,
} from '../logEmission'

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
