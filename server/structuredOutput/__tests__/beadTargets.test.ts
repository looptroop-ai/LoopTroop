import { describe, expect, it } from 'vitest'
import { normalizeBeadsJsonlOutput } from '../beadsOutput'

function bead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'verify-config',
    title: 'Verify the prerequisite',
    description: 'Read the prerequisite configuration and report its value.',
    prdRefs: ['US-1'],
    contextGuidance: { patterns: ['Read existing configuration.'], anti_patterns: ['Do not invent a repository target.'] },
    acceptanceCriteria: ['The prerequisite is verified.'],
    tests: ['Verify the observed value.'],
    testCommands: [],
    testCommandReason: 'Verification uses an existing configuration file.',
    targetFiles: [],
    ...overrides,
  }
}

describe('expanded bead target parsing', () => {
  it.each([
    [],
    ['C:/Users/User/.config/tool/settings.json'],
    ['/home/user/.config/tool/settings.json'],
    ['../shared/settings.json'],
    ['src/config.json', '/outside/settings.json'],
  ].map((targetFiles) => ({ targetFiles })))('preserves explicit targets %j without a parser intervention', ({ targetFiles }) => {
    const original = bead({ targetFiles })
    const result = normalizeBeadsJsonlOutput(JSON.stringify(original))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.targetFiles).toEqual(targetFiles)
    expect(result.value[0]?.description).toBe(original.description)
    expect(result.repairWarnings).toEqual([])
  })

  it.each([undefined, null, false, 7, {}, '', '  ', [null], [7], [{}], [''], ['file\0name']].map((targetFiles) => ({ targetFiles })))(
    'rejects missing or damaged targets %j instead of replacing them with []',
    ({ targetFiles }) => {
      const result = normalizeBeadsJsonlOutput(JSON.stringify(bead({ targetFiles })))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('targetFiles list of non-empty file paths')
    },
  )

  it('retains the existing single-path list repair and reports it', () => {
    const target = '/outside/settings.json'
    const result = normalizeBeadsJsonlOutput(JSON.stringify(bead({ targetFiles: target })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.targetFiles).toEqual([target])
    expect(result.repairWarnings).toContain(`Wrapped the single targetFiles path at bead index 0 in a list: ${JSON.stringify(target)} -> ${JSON.stringify([target])}.`)
  })

  it('accepts the existing target_files alias with an explicit empty list', () => {
    const record = bead({ target_files: [] }) as Record<string, unknown>
    delete record.targetFiles
    const result = normalizeBeadsJsonlOutput(JSON.stringify(record))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.targetFiles).toEqual([])
  })
})
