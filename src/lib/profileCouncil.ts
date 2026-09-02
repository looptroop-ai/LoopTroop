import { isRecord } from '@shared/typeGuards'

/**
 * The council roster as stored on the profile.
 *
 * Both fields are JSON *strings* in the database, so anything reading them is
 * parsing untrusted text: two surfaces did it inline, one of them during render,
 * and both asserted the result (`v as string`, `as Record<string, string>`)
 * without checking. A stored variant that is not a string then reached an
 * `<EffortBadge variant={…}>`, and a members list that is not an array reached
 * `.length`.
 */
export interface ProfileCouncil {
  /** Ordered member ids; the first is the main implementer. */
  members: string[]
  /** Effort variant per member id. Entries whose value is not a string are dropped. */
  variants: Record<string, string>
}

const EMPTY_COUNCIL: ProfileCouncil = { members: [], variants: {} }

function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function readMembers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((member): member is string => typeof member === 'string' && member.trim().length > 0)
}

function readVariants(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const variants: Record<string, string> = {}
  for (const [modelId, variant] of Object.entries(value)) {
    if (typeof variant === 'string' && variant.trim().length > 0) variants[modelId] = variant
  }
  return variants
}

export function getProfileCouncil(profile: {
  councilMembers?: string | null
  councilMemberVariants?: string | null
} | null | undefined): ProfileCouncil {
  if (!profile) return EMPTY_COUNCIL
  return {
    members: readMembers(parseJson(profile.councilMembers)),
    variants: readVariants(parseJson(profile.councilMemberVariants)),
  }
}
