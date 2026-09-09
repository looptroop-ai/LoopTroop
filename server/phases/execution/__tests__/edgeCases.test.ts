import { describe, it, expect } from 'vitest'
import { isAllowedFile } from '../gitOps'

describe('File Change Classification Edge Cases', () => {
  it('treats untracked .env files as local noise', () => expect(isAllowedFile('.env')).toBe(false))
  it('allows arbitrary project assets by extension', () => expect(isAllowedFile('image.png')).toBe(true))
  it('allows config files', () => expect(isAllowedFile('tsconfig.json')).toBe(true))
  it('blocks deep runtime paths', () => expect(isAllowedFile('.ticket/runtime/session/abc')).toBe(false))
})
