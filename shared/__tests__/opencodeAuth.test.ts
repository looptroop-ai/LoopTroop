import { describe, expect, it } from 'vitest'
import {
  getOpenCodeBasicAuthConfig,
  getOpenCodeBasicAuthHeader,
  getOpenCodeV2BasicAuthHeader,
  hasOpenCodePassword,
  withOpenCodePasswordAliases,
} from '../opencodeAuth'

describe('opencode auth helpers', () => {
  it('returns nullish auth values when no password is configured', () => {
    expect(getOpenCodeBasicAuthConfig({})).toBeNull()
    expect(getOpenCodeBasicAuthHeader({})).toBeUndefined()
  })

  it('builds a basic auth header with the default username', () => {
    expect(getOpenCodeBasicAuthConfig({ OPENCODE_SERVER_PASSWORD: 'secret' })).toEqual({
      username: 'opencode',
      password: 'secret',
    })
    expect(getOpenCodeBasicAuthHeader({ OPENCODE_SERVER_PASSWORD: 'secret' })).toBe('Basic b3BlbmNvZGU6c2VjcmV0')
  })

  it('uses an explicit username when provided', () => {
    expect(getOpenCodeBasicAuthHeader({
      OPENCODE_SERVER_USERNAME: 'looptroop',
      OPENCODE_SERVER_PASSWORD: 'secret',
    })).toBe('Basic bG9vcHRyb29wOnNlY3JldA==')
  })

  it('uses v2 password precedence and its fixed username', () => {
    expect(getOpenCodeV2BasicAuthHeader({
      OPENCODE_SERVER_USERNAME: 'custom-v1-user',
      OPENCODE_PASSWORD: 'v2-secret',
      OPENCODE_SERVER_PASSWORD: 'v1-secret',
    })).toBe(`Basic ${Buffer.from('opencode:v2-secret').toString('base64')}`)
    expect(getOpenCodeV2BasicAuthHeader({ OPENCODE_PASSWORD: ' leading and trailing ' }))
      .toBe(`Basic ${Buffer.from('opencode: leading and trailing ').toString('base64')}`)
    expect(getOpenCodeV2BasicAuthHeader({
      OPENCODE_PASSWORD: ' ',
      OPENCODE_SERVER_PASSWORD: ' legacy with spaces ',
    })).toBe(`Basic ${Buffer.from('opencode: legacy with spaces ').toString('base64')}`)
    expect(getOpenCodeV2BasicAuthHeader({ OPENCODE_PASSWORD: '  ' })).toBeUndefined()
  })

  it('fills missing or blank aliases and preserves two configured values', () => {
    expect(withOpenCodePasswordAliases({ OPENCODE_PASSWORD: 'new' })).toEqual({
      OPENCODE_PASSWORD: 'new',
      OPENCODE_SERVER_PASSWORD: 'new',
    })
    expect(withOpenCodePasswordAliases({ OPENCODE_SERVER_PASSWORD: 'old' })).toEqual({
      OPENCODE_PASSWORD: 'old',
      OPENCODE_SERVER_PASSWORD: 'old',
    })
    expect(withOpenCodePasswordAliases({ OPENCODE_PASSWORD: 'new', OPENCODE_SERVER_PASSWORD: 'old' })).toEqual({
      OPENCODE_PASSWORD: 'new',
      OPENCODE_SERVER_PASSWORD: 'old',
    })
    expect(withOpenCodePasswordAliases({ OPENCODE_PASSWORD: '', OPENCODE_SERVER_PASSWORD: 'old' })).toEqual({
      OPENCODE_PASSWORD: 'old',
      OPENCODE_SERVER_PASSWORD: 'old',
    })
    expect(withOpenCodePasswordAliases({ OPENCODE_PASSWORD: 'new', OPENCODE_SERVER_PASSWORD: '  ' })).toEqual({
      OPENCODE_PASSWORD: 'new',
      OPENCODE_SERVER_PASSWORD: 'new',
    })
  })

  it('treats whitespace-only aliases as unset', () => {
    expect(hasOpenCodePassword({ OPENCODE_PASSWORD: ' ', OPENCODE_SERVER_PASSWORD: '\t' })).toBe(false)
    expect(hasOpenCodePassword({ OPENCODE_PASSWORD: 'secret', OPENCODE_SERVER_PASSWORD: '' })).toBe(true)
  })
})
