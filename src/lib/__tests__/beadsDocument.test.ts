import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseBeadsArtifact } from '../beadsDocument'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseBeadsArtifact', () => {
  it('reads a plain array of beads', () => {
    expect(parseBeadsArtifact('[{"id":"B-1","title":"One"}]')).toEqual([{ id: 'B-1', title: 'One' }])
  })

  it('reads the enveloped form', () => {
    expect(parseBeadsArtifact('{"beads":[{"id":"B-1"}]}')).toEqual([{ id: 'B-1' }])
  })

  // The JSONL branch used to return null for the whole artifact the moment one
  // line failed, which hid every intact bead behind one damaged line. The
  // server's `readBeadsFile` skips the bad entry and keeps the rest; this now
  // matches it.
  it('keeps the intact beads when one JSONL line is unparseable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const content = ['{"id":"B-1","title":"One"}', '{"id":"B-2", oops', '{"id":"B-3","title":"Three"}'].join('\n')

    expect(parseBeadsArtifact(content)).toEqual([
      { id: 'B-1', title: 'One' },
      { id: 'B-3', title: 'Three' },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line 2'))
  })

  it('skips entries with no usable id and reports their line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const content = ['{"id":"B-1"}', '{"title":"no id"}', '{"id":"   "}'].join('\n')

    expect(parseBeadsArtifact(content)).toEqual([{ id: 'B-1' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable id'))
  })

  // A JSON object that is not a bead used to render as a fabricated one-bead
  // artifact; returning null is what sends the caller to the raw view.
  it('refuses a JSON object that is not bead-shaped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseBeadsArtifact('{"status":"pending"}')).toBeNull()
  })

  it('returns null when nothing survives', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseBeadsArtifact('{not json at all')).toBeNull()
    expect(parseBeadsArtifact('')).toBeNull()
  })

  it('ignores blank lines between entries', () => {
    expect(parseBeadsArtifact('{"id":"B-1"}\n\n{"id":"B-2"}')).toEqual([{ id: 'B-1' }, { id: 'B-2' }])
  })
})
