import { describe, expect, it } from 'vitest'
import {
  parseCandidateChangedFiles,
  parseCandidateFileAuditResponse,
} from '../candidateFileAudit'

describe('candidate file audit parsing', () => {
  const changedFiles = [
    { path: 'src/feature.ts', status: 'M' },
    { path: 'dist/bundle.js', status: 'M' },
    { path: 'tmp/output.log', status: 'A' },
  ]

  it('parses include, exclude, and review decisions', () => {
    const entries = parseCandidateFileAuditResponse([
      'files:',
      '  - path: src/feature.ts',
      '    decision: include',
      '    reason: Implements the requested feature.',
      '  - path: dist/bundle.js',
      '    decision: review',
      '    reason: Generated-looking tracked artifact, kept for reviewer attention.',
      '  - path: tmp/output.log',
      '    decision: exclude',
      '    reason: Test log output unrelated to the code change.',
    ].join('\n'), changedFiles)

    expect(entries).toEqual([
      { path: 'src/feature.ts', decision: 'include', reason: 'Implements the requested feature.' },
      { path: 'dist/bundle.js', decision: 'review', reason: 'Generated-looking tracked artifact, kept for reviewer attention.' },
      { path: 'tmp/output.log', decision: 'exclude', reason: 'Test log output unrelated to the code change.' },
    ])
  })

  it('repairs proven mapping formatting while preserving file paths and reason text', () => {
    const repairWarnings: string[] = []
    const entries = parseCandidateFileAuditResponse([
      'files:',
      '  - path:src/feature.ts',
      '    decision: include',
      '    reason: Source contains: a colon and remains unchanged.',
      '  - path:dist/bundle.js',
      '    decision: review',
      '    reason: Generated-looking tracked artifact, kept for reviewer attention.',
      '  - path:tmp/output.log',
      '    decision: exclude',
      '    reason: Test log output unrelated to the code change.',
    ].join('\n'), changedFiles, repairWarnings)

    expect(entries).toEqual([
      { path: 'src/feature.ts', decision: 'include', reason: 'Source contains: a colon and remains unchanged.' },
      { path: 'dist/bundle.js', decision: 'review', reason: 'Generated-looking tracked artifact, kept for reviewer attention.' },
      { path: 'tmp/output.log', decision: 'exclude', reason: 'Test log output unrelated to the code change.' },
    ])
    expect(repairWarnings).toEqual(expect.arrayContaining([
      'Repaired YAML mapping keys missing a space after colon before parsing.',
      'Quoted YAML plain scalar values containing colon-space before reparsing.',
    ]))
  })

  it('rejects invalid paths', () => {
    expect(() => parseCandidateFileAuditResponse([
      'files:',
      '  - path: ../secret',
      '    decision: exclude',
      '    reason: Invalid.',
      '  - path: dist/bundle.js',
      '    decision: include',
      '    reason: Keep.',
      '  - path: tmp/output.log',
      '    decision: exclude',
      '    reason: Log output.',
    ].join('\n'), changedFiles)).toThrow(/invalid or unknown path/i)
  })

  it('rejects exclusions without evidence', () => {
    expect(() => parseCandidateFileAuditResponse([
      'files:',
      '  - path: src/feature.ts',
      '    decision: include',
      '    reason: Keep.',
      '  - path: dist/bundle.js',
      '    decision: include',
      '    reason: Keep.',
      '  - path: tmp/output.log',
      '    decision: exclude',
      '    reason: ""',
    ].join('\n'), changedFiles)).toThrow(/must include a reason/i)
  })

  it('requires every changed file to be classified exactly once', () => {
    expect(() => parseCandidateFileAuditResponse([
      'files:',
      '  - path: src/feature.ts',
      '    decision: include',
      '    reason: Keep.',
    ].join('\n'), changedFiles)).toThrow(/did not classify every changed file/i)
  })

  it('normalizes git name-status output into changed files', () => {
    expect(parseCandidateChangedFiles([
      'M\tsrc/feature.ts',
      'A\ttmp/output.log',
      'R100\told/name.ts\tnew/name.ts',
      'M\t.ticket/internal.json',
    ].join('\n'))).toEqual([
      { path: 'src/feature.ts', status: 'M' },
      { path: 'tmp/output.log', status: 'A' },
      { path: 'new/name.ts', status: 'R100' },
    ])
  })
})
