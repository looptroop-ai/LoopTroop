import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  describeDevFrontendMode,
  resolveDevFrontendMode,
  LOOPTROOP_DEV_FRONTEND,
} from '../scripts/dev-frontend-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveDevFrontendMode', () => {
  it('defaults to the dev server when nothing asked otherwise', () => {
    expect(resolveDevFrontendMode({})).toBe('dev')
    expect(resolveDevFrontendMode({ [LOOPTROOP_DEV_FRONTEND]: '' })).toBe('dev')
  })

  it('accepts the spellings someone would reach for', () => {
    for (const value of ['preview', 'built', 'build', 'PREVIEW', '  Preview  ']) {
      expect(resolveDevFrontendMode({ [LOOPTROOP_DEV_FRONTEND]: value }), value).toBe('preview')
    }
  })

  it('accepts the explicit dev spellings too', () => {
    for (const value of ['dev', 'hmr', 'default', 'DEV']) {
      expect(resolveDevFrontendMode({ [LOOPTROOP_DEV_FRONTEND]: value }), value).toBe('dev')
    }
  })

  it('warns and falls back on a typo rather than silently serving the wrong thing', () => {
    // Someone who typed "preveiw" wanted the built bundle. Quietly handing them
    // the dev server hides the exact slowness they were trying to remove.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(resolveDevFrontendMode({ [LOOPTROOP_DEV_FRONTEND]: 'preveiw' })).toBe('dev')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('preveiw')
    expect(warn.mock.calls[0]?.[0]).toContain(LOOPTROOP_DEV_FRONTEND)
  })
})

describe('describeDevFrontendMode', () => {
  it('says hot reload is gone, because that is the whole trade', () => {
    expect(describeDevFrontendMode('preview')).toContain('no hot reload')
    expect(describeDevFrontendMode('dev')).toContain('hot reload')
  })
})
