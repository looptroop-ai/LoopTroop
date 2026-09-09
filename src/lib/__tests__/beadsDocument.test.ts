import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  BEAD_FIELD_ALIASES,
  countBeadsInContent,
  normalizeBead,
  parseBeadsArtifact,
  readBeadDependencies,
  readBeadNumber,
  readBeadString,
  readBeadStringList,
  readBeadValue,
  hasUnstructuredBeadGuidance,
  stripSupersededBeadAliases,
  SUPERSEDED_BEAD_FIELD_ALIASES,
  type RawBead,
} from '../beadsDocument'

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

  // The regex is a last resort for content the parser could not read at all.
  // Reaching it for a collection the parser *did* read and rejected would
  // report beads over a viewer showing raw text.
  it('counts zero when the parser read a collection and rejected every entry', () => {
    expect(countBeadsInContent('- id: {}\n')).toBe(0)
    expect(parseBeadsArtifact('- id: {}\n')).toBeNull()
  })

  // A summary chip is redrawn on every render; parser diagnostics belong to the
  // one place that actually reads the artifact.
  it('counts without logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    countBeadsInContent('[null, 42, {"id":"B-1"}]')

    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * One alias table, two reading policies.
 *
 * The alias lists used to be written out at every call site — about twenty in
 * the artifact viewer, a dozen more in the approval editor's normalizer — and
 * had already drifted apart. What the two sides must *not* share is the
 * whitespace policy: a view trims, an editor gives back what is stored.
 */
describe('the bead field readers', () => {
  it('prefers the first spelling and falls back through the rest', () => {
    expect(readBeadString({ prd_refs: [] , title: 'camel' }, 'title', 'display')).toBe('camel')
    expect(readBeadStringList({ prdRefs: ['a'], prd_refs: ['b'], prd_references: ['c'] }, 'prdRefs', 'display'))
      .toEqual(['a'])
    expect(readBeadStringList({ prd_refs: ['b'], prd_references: ['c'] }, 'prdRefs', 'display')).toEqual(['b'])
    expect(readBeadStringList({ prd_references: ['c'] }, 'prdRefs', 'display')).toEqual(['c'])
  })

  it('reads the camelCase dependency spelling, which only the editor used to accept', () => {
    // The divergence this table exists to end: a bead written with `blockedBy`
    // showed its dependencies on the approval screen and none in the artifact
    // view.
    expect(readBeadDependencies({ dependencies: { blockedBy: ['B-1'], blocks: ['B-2'] } }, 'display'))
      .toEqual({ blocked_by: ['B-1'], blocks: ['B-2'] })
    expect(readBeadDependencies({ dependencies: { blocked_by: ['B-1'] } }, 'display'))
      .toEqual({ blocked_by: ['B-1'], blocks: [] })
  })

  it.each([
    ['a dependencies field that is not an object', { dependencies: 'none' } as unknown as RawBead],
    ['a dependencies array', { dependencies: [] } as unknown as RawBead],
    ['no dependencies at all', {} as RawBead],
  ])('reads empty lists from %s', (_, bead) => {
    expect(readBeadDependencies(bead, 'display')).toEqual({ blocked_by: [], blocks: [] })
  })

  it('trims for display and keeps the text exactly for an editor', () => {
    const bead = { title: '  spaced  ', tests: ['  a  ', '   ', 'b'] }

    expect(readBeadString(bead, 'title', 'display')).toBe('spaced')
    expect(readBeadString(bead, 'title', 'verbatim')).toBe('  spaced  ')
    expect(readBeadStringList(bead, 'tests', 'display')).toEqual(['a', 'b'])
    expect(readBeadStringList(bead, 'tests', 'verbatim')).toEqual(['  a  ', '   ', 'b'])
  })

  it('skips a blank value for display but not for an editor', () => {
    // A stored `title: "  "` is not a title on screen; in the editor it is
    // what the person typed and has to come back unchanged.
    const bead = { title: '   ', description: 42 } as unknown as RawBead

    expect(readBeadString(bead, 'title', 'display')).toBe('')
    expect(readBeadString(bead, 'title', 'verbatim')).toBe('   ')
    expect(readBeadString(bead, 'description', 'display')).toBe('')
  })

  it('drops list entries that are not strings, under either policy', () => {
    const bead = { tests: ['a', null, 7, 'b'] } as unknown as RawBead

    expect(readBeadStringList(bead, 'tests', 'display')).toEqual(['a', 'b'])
    expect(readBeadStringList(bead, 'tests', 'verbatim')).toEqual(['a', 'b'])
  })

  it('reads a finite number and nothing else', () => {
    expect(readBeadNumber({ priority: 3 }, 'priority')).toBe(3)
    expect(readBeadNumber({ priority: 0 }, 'priority')).toBe(0)
    expect(readBeadNumber({ priority: Number.NaN }, 'priority')).toBeNull()
    expect(readBeadNumber({ priority: '3' } as unknown as RawBead, 'priority')).toBeNull()
    expect(readBeadNumber({}, 'priority')).toBeNull()
  })

  it('hands the whole value back for the fields a renderer judges itself', () => {
    const origin = { sourceItems: [] } as unknown as NonNullable<RawBead['qaOrigin']>

    expect(readBeadValue({ qa_origin: origin }, 'qaOrigin')).toBe(origin)
    // A stored `null` is not a value: the next spelling has to be tried.
    expect(readBeadValue({ qaOrigin: null, qa_origin: origin }, 'qaOrigin')).toBe(origin)
    expect(readBeadValue({}, 'qaOrigin')).toBeUndefined()
  })

  it('lists the canonical spelling first for every field', () => {
    // The canonical name is the key, so a table whose first alias was not the
    // key would make the readers and the normalized shape disagree.
    for (const [field, aliases] of Object.entries(BEAD_FIELD_ALIASES)) {
      expect(aliases[0]).toBe(field)
    }
  })
})

describe('normalizeBead', () => {
  it('reads every aliased field onto its canonical name', () => {
    const normalized = normalizeBead({
      id: 'B-1',
      title: 'Title',
      prd_refs: ['PRD-1'],
      acceptance_criteria: ['AC-1'],
      test_commands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
      test_command_reason: 'why',
      target_files: ['src/app.ts'],
      context_guidance: { patterns: ['p'], antiPatterns: ['a'] },
      dependencies: { blockedBy: ['B-0'], blocks: [] },
    } as never, 'display')

    expect(normalized).toMatchObject({
      id: 'B-1',
      prdRefs: ['PRD-1'],
      acceptanceCriteria: ['AC-1'],
      testCommandReason: 'why',
      targetFiles: ['src/app.ts'],
      contextGuidance: { patterns: ['p'], anti_patterns: ['a'] },
      dependencies: { blocked_by: ['B-0'], blocks: [] },
    })
    expect(normalized.testCommands).toHaveLength(1)
  })

  it('fills in every field the editor writes to, even for a bare bead', () => {
    const normalized = normalizeBead({ id: 'B-1' }, 'verbatim')

    expect(normalized).toMatchObject({
      title: '',
      description: '',
      prdRefs: [],
      acceptanceCriteria: [],
      tests: [],
      testCommands: [],
      targetFiles: [],
      contextGuidance: { patterns: [], anti_patterns: [] },
      dependencies: { blocked_by: [], blocks: [] },
    })
  })

  it('keeps fields it does not know, which the save path writes back', () => {
    const normalized = normalizeBead({ id: 'B-1', somethingNew: { kept: true } }, 'verbatim')

    expect(normalized.somethingNew).toEqual({ kept: true })
  })

  it('omits a test command reason that is not there', () => {
    expect(normalizeBead({ id: 'B-1' }, 'display').testCommandReason).toBeUndefined()
  })

  it('drops every command entry that is not a command spec, bare strings included', () => {
    // The schema is the contract the command runner reads; a bare string is
    // an older shape it cannot execute, so it is dropped rather than guessed at.
    const normalized = normalizeBead({
      id: 'B-1',
      testCommands: ['npm test', null, { mode: 'nonsense' }, { mode: 'shell', shell: 'posix', script: 'npm test' }],
    } as never, 'display')

    expect(normalized.testCommands).toEqual([
      expect.objectContaining({ mode: 'shell', script: 'npm test' }),
    ])
  })
})

describe('the superseded spellings', () => {
  it('lists every alias that is not the canonical name, and no canonical name', () => {
    expect(SUPERSEDED_BEAD_FIELD_ALIASES).toContain('prd_refs')
    expect(SUPERSEDED_BEAD_FIELD_ALIASES).toContain('context_guidance')
    expect(SUPERSEDED_BEAD_FIELD_ALIASES).not.toContain('prdRefs')
    for (const field of Object.keys(BEAD_FIELD_ALIASES)) {
      expect(SUPERSEDED_BEAD_FIELD_ALIASES).not.toContain(field)
    }
  })

  it('drops them and keeps everything else', () => {
    // What a save writes: each field once. The superseded copy held the
    // pre-edit value, so a reader preferring that spelling saw the edit undone.
    expect(stripSupersededBeadAliases({
      id: 'B-1',
      prdRefs: ['NEW'],
      prd_refs: ['OLD'],
      context_guidance: { patterns: [] },
      somethingUnknown: { kept: true },
    } as unknown as RawBead)).toEqual({
      id: 'B-1',
      prdRefs: ['NEW'],
      somethingUnknown: { kept: true },
    })
  })
})

describe('hasUnstructuredBeadGuidance', () => {
  it.each([
    ['guidance written as free text', { contextGuidance: 'Patterns: do X; avoid Y' }],
    ['the same under the other spelling', { context_guidance: 'Patterns: do X' }],
  ])('reports %s', (_, bead) => {
    expect(hasUnstructuredBeadGuidance(bead as RawBead)).toBe(true)
  })

  it.each([
    ['a structured guidance object', { contextGuidance: { patterns: ['p'], anti_patterns: [] } }],
    ['no guidance at all', {}],
  ])('does not report %s', (_, bead) => {
    expect(hasUnstructuredBeadGuidance(bead as RawBead)).toBe(false)
  })
})

describe('normalizeBead reads the read-only metadata fields too', () => {
  it('resolves issueType and externalRef from either spelling', () => {
    // The editor renders these straight off the record, so a bead stored with
    // the snake_case spelling read as a default there while the artifact view
    // showed the real value.
    const normalized = normalizeBead({ id: 'B-1', issue_type: 'bug', external_ref: 'LOO-9' } as never, 'display')

    expect(normalized.issueType).toBe('bug')
    expect(normalized.externalRef).toBe('LOO-9')
  })
})
