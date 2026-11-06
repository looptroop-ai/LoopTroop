import { describe, expect, it } from 'vitest'
import {
  canStoreDebugPayloadInData,
  compactLogEntryForStorage,
  expandStoredLogEntry,
  PAYLOAD_IN_DATA_FIELD,
} from '../storedEntry'

/** What a stored line looks like after the disk round trip. */
function roundTrip<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

describe('compactLogEntryForStorage', () => {
  it('leaves out content only when it is the same text as message', () => {
    expect(compactLogEntryForStorage({ message: 'same', content: 'same', kind: 'text' })).toEqual({ message: 'same', kind: 'text' })
    expect(compactLogEntryForStorage({ message: 'summary', content: 'full output' })).toEqual({ message: 'summary', content: 'full output' })
    const noContent = { message: 'only' }
    expect(compactLogEntryForStorage(noContent)).toBe(noContent)
  })
})

describe('expandStoredLogEntry', () => {
  it('puts back the content a stored line left out and leaves full lines alone', () => {
    expect(expandStoredLogEntry({ message: 'hello', op: 'append' })).toEqual({ message: 'hello', op: 'append', content: 'hello' })
    const full = { message: 'summary', content: 'full output' }
    expect(expandStoredLogEntry(full)).toBe(full)
  })

  it('rebuilds a debug line stored once byte-for-byte after the disk round trip', () => {
    const label = '[DEBUG] opencode.coding_main.raw_message'
    const payload = {
      memberId: 'provider/model',
      message: { id: 'msg_1', role: 'assistant', parts: [{ type: 'text', text: 'Línea ✓ 😀\n"quoted"' }] },
      tokens: { input: 1200, output: 0, ratio: 0.5 },
      empty: null,
      flags: [true, false],
    }
    const text = `${label} ${JSON.stringify(payload)}`
    const data = { ...payload, timestamp: '2026-03-13T12:00:00.000Z' }
    const stored = compactLogEntryForStorage({ message: label, content: label, data, [PAYLOAD_IN_DATA_FIELD]: true as const })

    expect(stored).not.toHaveProperty('content')
    const readable = expandStoredLogEntry(roundTrip(stored))
    expect(readable.message).toBe(text)
    expect(readable.content).toBe(text)
    expect(readable).not.toHaveProperty(PAYLOAD_IN_DATA_FIELD)
    expect(readable.data).toEqual(data)
  })
})

describe('canStoreDebugPayloadInData', () => {
  it('accepts plain object payloads whose text is their JSON', () => {
    const payload = { sessionId: 'ses-1', nested: { value: 1 } }
    expect(canStoreDebugPayloadInData(payload, JSON.stringify(payload))).toBe(true)
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 })
    expect(canStoreDebugPayloadInData(bare, JSON.stringify(bare))).toBe(true)
  })

  it.each([
    ['an array', [1, 2], '[1,2]'],
    ['a string', 'plain text', 'plain text'],
    ['a number', 42, '42'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['a payload with its own timestamp', { timestamp: 'payload time', value: 1 }, '{"timestamp":"payload time","value":1}'],
    ['a class instance', new (class Payload { value = 1 })(), '{"value":1}'],
    ['a payload that did not serialize as JSON', { value: 1 }, '[object Object]'],
  ])('keeps the text in the line for %s', (_label, payload, text) => {
    expect(canStoreDebugPayloadInData(payload, text)).toBe(false)
  })
})
