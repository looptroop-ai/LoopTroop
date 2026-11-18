import { describe, expect, it } from 'vitest'
import { logSafe } from '../logSafe'

describe('logSafe', () => {
  it('leaves an ordinary ticket reference readable', () => {
    expect(logSafe('16:LOOP-1')).toBe('16:LOOP-1')
  })

  it('escapes line breaks so a value cannot start a second log entry', () => {
    expect(logSafe('LOOP-1\n[INFO] forged')).toBe('LOOP-1\\n[INFO] forged')
    expect(logSafe('LOOP-1\r\n[INFO] forged')).toBe('LOOP-1\\r\\n[INFO] forged')
    expect(logSafe('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c')
  })

  it('escapes terminal control sequences', () => {
    expect(logSafe('a\u001b[31mb')).toBe('a\\u001b[31mb')
  })

  it('stringifies values that are not strings', () => {
    expect(logSafe(42)).toBe('42')
    expect(logSafe(undefined)).toBe('undefined')
  })
})
