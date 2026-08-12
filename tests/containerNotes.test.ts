import { describe, expect, it } from 'vitest'
import { END, START, containerBlock, spliceContainerBlock } from '../scripts/container-notes'

const INPUT = {
  version: '0.5.0',
  indexDigest: `sha256:${'a'.repeat(64)}`,
  dhRef: 'looptroopai/looptroop',
  ghcrRef: 'ghcr.io/looptroop-ai/looptroop',
}

describe('containerBlock', () => {
  it('gives both pull commands, without the implicit docker.io host', () => {
    const block = containerBlock(INPUT)
    expect(block).toContain('docker pull looptroopai/looptroop:0.5.0')
    expect(block).toContain('docker pull ghcr.io/looptroop-ai/looptroop:0.5.0')
    expect(block).toContain(INPUT.indexDigest)
  })
})

describe('spliceContainerBlock', () => {
  const notes = '## Release Highlights\n\n- Something happened.\n'

  it('appends the block to notes that have none', () => {
    const next = spliceContainerBlock(notes, INPUT)
    expect(next.startsWith('## Release Highlights')).toBe(true)
    expect(next).toContain('docker pull looptroopai/looptroop:0.5.0')
    expect(next.endsWith('\n')).toBe(true)
  })

  it('replaces an existing block instead of appending a second one', () => {
    const once = spliceContainerBlock(notes, INPUT)
    const twice = spliceContainerBlock(once, { ...INPUT, indexDigest: `sha256:${'b'.repeat(64)}` })
    expect(twice.split(START)).toHaveLength(2)
    expect(twice.split(END)).toHaveLength(2)
    expect(twice).toContain('b'.repeat(64))
    expect(twice).not.toContain('a'.repeat(64))
  })

  it('leaves text on both sides of the block alone', () => {
    const body = `${notes}\n${START}\nold\n${END}\n\n## Checksums\n\n- sha256 ...\n`
    const next = spliceContainerBlock(body, INPUT)
    expect(next).toContain('## Release Highlights')
    expect(next).toContain('## Checksums')
    expect(next).not.toContain('old')
  })

  it('refuses to guess the bounds when one marker is missing', () => {
    // Someone edited inside the block; guessing where it ends could delete it.
    expect(() => spliceContainerBlock(`${notes}\n${START}\nhand written\n`, INPUT)).toThrow(/one container marker/)
    expect(() => spliceContainerBlock(`${notes}\nhand written\n${END}\n`, INPUT)).toThrow(/one container marker/)
  })
})
