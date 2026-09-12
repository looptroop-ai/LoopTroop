import { describe, expect, it } from 'vitest'
import { cacheParse, getCachedParse } from '../parseCache'

describe('structured parse cache', () => {
  it('owns stored values and returns fresh graphs and warning arrays on every hit', () => {
    const shared = { text: 'original' }
    const value = { first: shared, second: shared, date: new Date(0), bytes: new Uint8Array([1, 2]) }
    const repairWarnings = ['repair']
    cacheParse('ownership', value, repairWarnings)
    shared.text = 'changed by first caller'
    repairWarnings.push('first caller')
    const hit = getCachedParse('ownership')!
    expect(hit.value).toEqual({ ...value, first: { text: 'original' }, second: { text: 'original' } })
    const parsed = hit.value as typeof value
    expect(parsed.first).toBe(parsed.second)
    parsed.first.text = 'changed by second caller'
    parsed.date.setTime(1)
    parsed.bytes[0] = 9
    hit.repairWarnings.push('second caller')
    expect(getCachedParse('ownership')).toEqual({
      value: { first: { text: 'original' }, second: { text: 'original' }, date: new Date(0), bytes: new Uint8Array([1, 2]) },
      repairWarnings: ['repair'],
    })
  })

  it('evicts the least recently used entry at the entry limit', () => {
    for (let index = 0; index < 128; index++) cacheParse(`count-${index}`, index, [])
    expect(getCachedParse('count-0')?.value).toBe(0)
    cacheParse('count-overflow', 128, [])
    expect(getCachedParse('count-1')).toBeUndefined()
    expect(getCachedParse('count-0')?.value).toBe(0)
    expect(getCachedParse('count-overflow')?.value).toBe(128)
  })

  it('never shares binary backing buffers across cache hits', () => {
    cacheParse('binary-buffers', new Uint8Array([1, 2]), [])
    const first = getCachedParse('binary-buffers')!.value as Uint8Array
    const second = getCachedParse('binary-buffers')!.value as Uint8Array
    expect(first.buffer).not.toBe(second.buffer)
    new Uint8Array(first.buffer).fill(0)
    expect(second).toEqual(new Uint8Array([1, 2]))
    expect(getCachedParse('binary-buffers')!.value).toEqual(new Uint8Array([1, 2]))
  })

  it('evicts by serialized bytes and skips entries larger than the budget', () => {
    const large = 'x'.repeat(4 * 1024 * 1024)
    cacheParse('bytes-first', large, [])
    cacheParse('bytes-second', large, [])
    expect(getCachedParse('bytes-first')).toBeUndefined()
    expect(getCachedParse('bytes-second')?.value).toBe(large)
    cacheParse('oversized', large + large, [])
    expect(getCachedParse('oversized')).toBeUndefined()
    expect(getCachedParse('bytes-second')?.value).toBe(large)
  })

  it('accounts for replacement bytes and key bytes', () => {
    const large = 'x'.repeat(3 * 1024 * 1024)
    cacheParse('replace', large, [])
    cacheParse('replace', large, [])
    cacheParse('after-replace', large, [])
    expect(getCachedParse('replace')?.value).toBe(large)
    expect(getCachedParse('after-replace')?.value).toBe(large)
    const oversizedKey = 'k'.repeat(4 * 1024 * 1024)
    cacheParse(oversizedKey, null, [])
    expect(getCachedParse(oversizedKey)).toBeUndefined()
  })

  it('preserves cycles and undefined results and bypasses unserializable values', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    cacheParse('cycle', cyclic, [])
    const parsed = getCachedParse('cycle')!.value as typeof cyclic
    expect(parsed.self).toBe(parsed)
    cacheParse('undefined', undefined, [])
    expect(getCachedParse('undefined')).toEqual({ value: undefined, repairWarnings: [] })
    expect(() => cacheParse('unsupported', () => {}, [])).not.toThrow()
    expect(getCachedParse('unsupported')).toBeUndefined()
  })
})
