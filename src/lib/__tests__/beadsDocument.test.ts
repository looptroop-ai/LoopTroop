import { describe, it, expect, vi, afterEach } from 'vitest'
import { countBeadsInContent, parseBeadsArtifact } from '../beadsDocument'

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

  // The array and envelope forms used to be cast straight through while only
  // the JSONL path validated, so `[null]` reached the viewer's field readers
  // and threw, and `[42]` rendered as a bead with placeholder values.
  it('skips entries that are not bead-shaped in the array form', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseBeadsArtifact('[null, 42, "nope", {"id":"B-1"}]')).toEqual([{ id: 'B-1' }])
    expect(warn).toHaveBeenCalled()
  })

  it('skips entries that are not bead-shaped in the envelope form', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseBeadsArtifact('{"beads":[null, {"id":"B-1"}]}')).toEqual([{ id: 'B-1' }])
  })

  it('falls back to raw when an array holds nothing bead-shaped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseBeadsArtifact('[null, 42]')).toBeNull()
    expect(parseBeadsArtifact('{"beads":[null]}')).toBeNull()
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

describe('countBeadsInContent', () => {
  // The two copies this replaced disagreed here: one early-returned 0 for
  // content that parsed to a single JSON object, before reaching its own JSONL
  // branch, while the other fell through and returned 1.
  it('counts a single-object JSONL artifact as one bead', () => {
    expect(countBeadsInContent('{"id":"B-1","title":"Only"}')).toBe(1)
  })

  it('counts each encoding the way the viewer renders it', () => {
    expect(countBeadsInContent('[{"id":"B-1"},{"id":"B-2"}]')).toBe(2)
    expect(countBeadsInContent('{"beads":[{"id":"B-1"}]}')).toBe(1)
    expect(countBeadsInContent('{"id":"B-1"}\n{"id":"B-2"}')).toBe(2)
  })

  // The count and the list under it must never disagree.
  it('does not count entries the parser drops', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const content = '[null, {"id":"B-1"}]'

    expect(countBeadsInContent(content)).toBe(1)
    expect(parseBeadsArtifact(content)).toHaveLength(1)
  })

  it('falls back to counting YAML bead ids the parser declines', () => {
    expect(countBeadsInContent('- id: B-1\n  title: One\n- id: B-2\n  title: Two\n')).toBe(2)
  })
})
