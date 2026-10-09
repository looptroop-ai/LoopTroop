import type { CreateProfileInput, Profile } from '@/hooks/useProfile'
import { SHARED_PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import { DEFAULT_IGNORE_MODE } from '@shared/ignoreMode'
import { numericFields, buildInitialRawNumeric } from './numericFieldConfig'
import { getProfileCouncil } from '@/lib/profileCouncil'

const DEFAULT_FORM_DATA = {
  ...SHARED_PROFILE_DEFAULTS,
  mainImplementer: '',
  gitHookPolicy: DEFAULT_GIT_HOOK_POLICY,
  ignoreMode: DEFAULT_IGNORE_MODE,
} satisfies CreateProfileInput

export type ProfileFormData = { [K in keyof typeof DEFAULT_FORM_DATA]: NonNullable<CreateProfileInput[K]> }

/** Copy only editable settings, applying the same defaults at mount and hydration. */
export const buildProfileFormData = (profile: Profile | null | undefined): ProfileFormData =>
  Object.fromEntries((Object.keys(DEFAULT_FORM_DATA) as (keyof ProfileFormData)[]).map(key => [
    key, profile?.[key] ?? DEFAULT_FORM_DATA[key],
  ])) as ProfileFormData

export const buildHydratedProfileDraft = (profile: Profile) => {
  const formData = buildProfileFormData(profile)
  const rawNumeric = buildInitialRawNumeric(formData)
  const mainVariant = profile.mainImplementerVariant || undefined
  const council = getProfileCouncil(profile)
  const councilVariants = Object.fromEntries(Object.entries(council.variants).map(([id, variant]) => [cleanModelId(id), variant]))
  const councilSlots = council.members.filter(id => id !== profile.mainImplementer)
  const isWaitCustom = formData.aiQuestionWindow !== SHARED_PROFILE_DEFAULTS.aiQuestionWindow
  const snapshot = profileDraftSnapshot(formData, rawNumeric, councilSlots, mainVariant, councilVariants, isWaitCustom)
  return { formData, rawNumeric, mainVariant, councilVariants, councilSlots, isWaitCustom, snapshot }
}

export const initialProfileBaseline = (previous: string | null, initial: string | null, current: string) => previous ?? initial ?? current

export const cleanModelId = (id: string | null | undefined): string =>
  id?.startsWith('openrouter/') ? id.split(':')[0] ?? '' : id ?? ''

export const profileDraftSnapshot = (
  formData: CreateProfileInput,
  rawNumeric: Record<string, string>,
  councilSlots: string[],
  mainVariant: string | undefined,
  councilVariants: Record<string, string>,
  isAiQuestionWaitCustom: boolean,
): string => JSON.stringify({
  formData: Object.entries(formData).sort(([a], [b]) => a.localeCompare(b)),
  rawNumeric: Object.entries(rawNumeric).sort(([a], [b]) => a.localeCompare(b)),
  councilSlots,
  isAiQuestionWaitCustom,
  mainVariant: mainVariant && mainVariant !== 'none' ? mainVariant : null,
  councilVariants: Object.entries(councilVariants)
    .filter(([, value]) => value && value !== 'none')
    .sort(([a], [b]) => a.localeCompare(b)),
})

/** Convert validated numeric fields and include variants only for current council members. */
export const buildProfilePayload = (
  formData: ProfileFormData,
  rawNumeric: Record<string, string>,
  councilSlots: string[],
  mainVariant: string | undefined,
  councilVariants: Record<string, string>,
): CreateProfileInput => {
  const validatedData = {
    ...formData,
    ...Object.fromEntries(Object.entries(numericFields).map(([key, config]) => [key, config.toStore(Number(rawNumeric[key]))])),
  }
  const uniqueCouncil = [...new Set([validatedData.mainImplementer, ...councilSlots].filter(Boolean))]
  const variantsMap = Object.fromEntries(uniqueCouncil
    .filter(modelId => modelId !== validatedData.mainImplementer)
    .map(modelId => [modelId, councilVariants[cleanModelId(modelId)]])
    .filter(([, variant]) => variant && variant !== 'none'))
  return {
    ...validatedData,
    councilMembers: JSON.stringify(uniqueCouncil),
    mainImplementerVariant: mainVariant && mainVariant !== 'none' ? mainVariant : '',
    councilMemberVariants: Object.keys(variantsMap).length > 0 ? JSON.stringify(variantsMap) : '',
  }
}
