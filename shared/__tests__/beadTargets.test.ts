import { describe, expect, it } from 'vitest'
import { isBeadTargetFile, isExternalTargetFile } from '../beadTargets'

describe('bead target files', () => {
  it.each([
    '/home/user/.config/tool/settings.json',
    'C:/Users/User/.config/tool/settings.json',
    'C:\\Users\\User\\settings.json',
    '\\\\server\\share\\settings.json',
    '\\Users\\User\\settings.json',
    'C:settings.json',
    '../settings.json',
    '..\\settings.json',
    'src/../../settings.json',
    './src/../../settings.json',
    '~/settings.json',
    '~\\settings.json',
    '~',
    ' /outside/settings.json ',
  ])('identifies external path %s on every host platform', (filePath) => {
    expect(isExternalTargetFile(filePath)).toBe(true)
    expect(isBeadTargetFile(filePath)).toBe(true)
  })

  it.each([
    'src/settings.json',
    'src\\settings.json',
    './src/settings.json',
    'src/../settings.json',
    'src//nested/../../settings.json',
    '.config/settings.json',
    'settings..json',
    '~settings.json',
  ])('keeps repository-relative path %s unmarked', (filePath) => {
    expect(isExternalTargetFile(filePath)).toBe(false)
  })

  it.each([undefined, null, false, 42, {}, [], '', '   ', 'file\0name'].map((value) => ({ value })))('rejects invalid path %s', ({ value }) => {
    expect(isBeadTargetFile(value)).toBe(false)
  })
})
