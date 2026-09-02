import { describe, expect, it } from 'vitest'
import { getProfileCouncil } from '../profileCouncil'

describe('getProfileCouncil', () => {
  it('reads a well-formed roster', () => {
    const council = getProfileCouncil({
      councilMembers: JSON.stringify(['openai/gpt-5', 'anthropic/claude']),
      councilMemberVariants: JSON.stringify({ 'openai/gpt-5': 'high' }),
    })

    expect(council.members).toEqual(['openai/gpt-5', 'anthropic/claude'])
    expect(council.variants).toEqual({ 'openai/gpt-5': 'high' })
  })

  it('discards a variant that is not a string', () => {
    // It used to be cast with `v as string` and handed to `<EffortBadge>`.
    const council = getProfileCouncil({
      councilMemberVariants: JSON.stringify({ 'openai/gpt-5': { level: 'high' }, 'anthropic/claude': 'low', 'x/y': '  ' }),
    })

    expect(council.variants).toEqual({ 'anthropic/claude': 'low' })
  })

  it('discards members that are not non-empty strings', () => {
    const council = getProfileCouncil({
      councilMembers: JSON.stringify(['openai/gpt-5', 42, null, '', '   ']),
    })

    expect(council.members).toEqual(['openai/gpt-5'])
  })

  it('reads an empty roster from anything that is not the right shape', () => {
    // Previously `as string[]` on a stored object reached `.length` and
    // `rawMembers[0]`.
    expect(getProfileCouncil({ councilMembers: '{"a":1}' }).members).toEqual([])
    expect(getProfileCouncil({ councilMemberVariants: '[1,2]' }).variants).toEqual({})
    expect(getProfileCouncil({ councilMembers: 'not json' }).members).toEqual([])
    expect(getProfileCouncil({ councilMembers: null, councilMemberVariants: null }))
      .toEqual({ members: [], variants: {} })
    expect(getProfileCouncil(null)).toEqual({ members: [], variants: {} })
    expect(getProfileCouncil(undefined)).toEqual({ members: [], variants: {} })
  })
})
