import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { buildRelevantFilesArtifact, MAX_TOTAL_CHARS, type RelevantFileEntry } from '../relevantFiles'

function makeFile(path: string, relevance: RelevantFileEntry['relevance'], size: number): RelevantFileEntry {
  return {
    path,
    rationale: 'r'.repeat(size),
    relevance,
    likely_action: 'read',
    content: `raw content for ${path}`,
    content_preview: '',
  }
}

describe('buildRelevantFilesArtifact', () => {
  it('reports the included count and omits raw content', () => {
    const artifact = load(buildRelevantFilesArtifact('ABC-1', {
      file_count: 99,
      files: [
        { ...makeFile('src/high.ts', 'high', 4), content_preview: 'preview one' },
        { ...makeFile('src/low.ts', 'low', 3), content_preview: 'preview two' },
      ],
    }))

    expect(artifact).toEqual({
      ticket_id: 'ABC-1',
      artifact: 'relevant_files',
      file_count: 2,
      files: [
        { path: 'src/high.ts', rationale: 'rrrr', relevance: 'high', likely_action: 'read', content_preview: 'preview one' },
        { path: 'src/low.ts', rationale: 'rrr', relevance: 'low', likely_action: 'read', content_preview: 'preview two' },
      ],
    })
  })

  it('drops lower-priority files first and keeps the remaining files high-to-low', () => {
    const artifact = load(buildRelevantFilesArtifact('ABC-1', {
      file_count: 3,
      files: [
        makeFile('src/low.ts', 'low', MAX_TOTAL_CHARS - 2),
        makeFile('src/high.ts', 'high', 2),
        makeFile('src/medium.ts', 'medium', 1),
      ],
    })) as { file_count: number; files: Array<{ path: string; relevance: string }> }

    expect(artifact.file_count).toBe(2)
    expect(artifact.files.map(({ path, relevance }) => ({ path, relevance }))).toEqual([
      { path: 'src/high.ts', relevance: 'high' },
      { path: 'src/medium.ts', relevance: 'medium' },
    ])
  })

  it('keeps files whose rationale and preview exactly fill the character budget', () => {
    const file = { ...makeFile('src/boundary.ts', 'high', MAX_TOTAL_CHARS - 1), content_preview: 'p' }
    const artifact = load(buildRelevantFilesArtifact('ABC-1', { file_count: 1, files: [file] })) as {
      file_count: number
      files: Array<{ path: string }>
    }

    expect(artifact.file_count).toBe(1)
    expect(artifact.files.map(({ path }) => path)).toEqual(['src/boundary.ts'])
  })

  it('stops trimming when removing the last low-priority file reaches the exact budget', () => {
    const artifact = load(buildRelevantFilesArtifact('ABC-1', {
      file_count: 3,
      files: [
        makeFile('src/low.ts', 'low', 1),
        makeFile('src/high.ts', 'high', MAX_TOTAL_CHARS - 2),
        makeFile('src/medium.ts', 'medium', 2),
      ],
    })) as { file_count: number; files: Array<{ path: string }> }

    expect(artifact.file_count).toBe(2)
    expect(artifact.files.map(({ path }) => path)).toEqual(['src/high.ts', 'src/medium.ts'])
  })
})
