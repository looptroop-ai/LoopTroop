import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useProfile, useCreateProfile, useUpdateProfile } from '@/hooks/useProfile'
import { useToast } from '@/components/shared/useToast'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { useQueryClient } from '@tanstack/react-query'
import { useOpenCodeModels, refetchOpenCodeModelsQuery, refreshOpenCodeModelsQuery } from '@/hooks/useOpenCodeModels'
import { hasNumericErrors, buildInitialRawNumeric } from './numericFieldConfig'
import { buildProfileFormData, buildProfilePayload, profileDraftSnapshot, buildHydratedProfileDraft, initialProfileBaseline, type CouncilSlot, type ProfileFormData } from './profileFormData'
import { ProfileNumericSections } from './ProfileNumericSections'
import { ProfileAdvancedSettings } from './ProfileAdvancedSettings'
import { ProfileModelsSection } from './ProfileModelsSection'
import { ProfileConnectionStatus, ProfileFormActions } from './ProfileSetupFeedback'
import { describeQueryError } from '@/lib/fetchError'
import { getOpenCodeStatus, getOpenCodeSignInAdvice } from './profileConnectionState'

interface ProfileSetupProps {
  onClose: () => void
  onOpenAbout?: () => void
  onDirtyChange?: (isDirty: boolean) => void
}

export const ProfileSetup = ({ onClose, onOpenAbout, onDirtyChange }: ProfileSetupProps) => {
  const { data: profile, isLoading: profileLoading } = useProfile()
  const createProfile = useCreateProfile()
  const updateProfile = useUpdateProfile()
  const { addToast } = useToast()
  const queryClient = useQueryClient()

  const [formData, setFormData] = useState<ProfileFormData>(() => buildProfileFormData(profile))

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isAiQuestionWaitCustom, setIsAiQuestionWaitCustom] = useState(
    formData.aiQuestionWindow !== PROFILE_DEFAULTS.aiQuestionWindow,
  )
  const [hasAiQuestionWaitError, setHasAiQuestionWaitError] = useState(false)

  const [rawNumeric, setRawNumeric] = useState<Record<string, string>>(() => buildInitialRawNumeric({ ...formData }))

  const hasErrors = hasNumericErrors(rawNumeric) || hasAiQuestionWaitError

  const [councilSlots, setCouncilSlots] = useState<CouncilSlot[]>([])

  // Variant state: per-model variant selections
  const [mainVariant, setMainVariant] = useState<string | undefined>(undefined)
  const [councilVariants, setCouncilVariants] = useState<Record<string, string>>({})
  const profileBaselineRef = useRef<string | null>(null)
  const profileHydratedRef = useRef(false)
  const initialDraftRef = useRef<string | null>(null)
  const draftSnapshot = profileDraftSnapshot(formData, rawNumeric, councilSlots, mainVariant, councilVariants, isAiQuestionWaitCustom)
  const draftSnapshotRef = useRef(draftSnapshot)
  draftSnapshotRef.current = draftSnapshot
  if (initialDraftRef.current === null) initialDraftRef.current = draftSnapshot

  // Models data for variant info
  const {
    data: models,
    isLoading: modelsLoading,
    isError: modelsError,
    isFetching: modelsFetching,
  } = useOpenCodeModels()
  const modelVariantMap = useMemo(() => {
    const map = new Map<string, Record<string, Record<string, unknown>>>()
    if (models) {
      for (const m of models) {
        if (m.variants && Object.keys(m.variants).length > 0) {
          map.set(m.fullId, m.variants)
        }
      }
    }
    return map
  }, [models])
  const recordFirstEditedHydration = useCallback((isFirst: boolean, baseline: string) => {
    if (!isFirst) return
    profileBaselineRef.current = baseline
    onDirtyChange?.(true)
  }, [onDirtyChange])

  // Sync form state when profile data loads. Once the user has changed a draft,
  // later query refreshes update the baseline only after a successful save; they
  // must not replace the values the user is still editing.
  useEffect(() => {
    if (!profile) {
      profileBaselineRef.current = initialProfileBaseline(profileBaselineRef.current, initialDraftRef.current, draftSnapshotRef.current)
      return
    }
    const isFirstProfileHydration = !profileHydratedRef.current
    profileHydratedRef.current = true
    const next = buildHydratedProfileDraft(profile)
    const currentDraftIsDirty = draftSnapshotRef.current !== (profileBaselineRef.current ?? initialDraftRef.current)
    if (currentDraftIsDirty) {
      recordFirstEditedHydration(isFirstProfileHydration, next.snapshot)
      return
    }
    if (profileBaselineRef.current === next.snapshot) return

    setFormData(next.formData)
    setRawNumeric(next.rawNumeric)
    setIsAiQuestionWaitCustom(next.isWaitCustom)
    setMainVariant(next.mainVariant)
    setCouncilVariants(next.councilVariants)
    setCouncilSlots(next.councilSlots)
    profileBaselineRef.current = next.snapshot
  }, [profile, profileLoading, recordFirstEditedHydration])

  const isDirty = profileBaselineRef.current !== null && draftSnapshot !== profileBaselineRef.current
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const handleClose = () => {
    if (isDirty && !window.confirm('Discard your unsaved profile changes?')) return
    onClose()
  }

  const [isOpenCodeConnected, setIsOpenCodeConnected] = useState<boolean | null>(null)
  // A server that refused LoopTroop's sign-in is running: the fix is its
  // password, not a restart. The server words which password, since it knows
  // whether one was sent at all.
  const [openCodeRefusedSignIn, setOpenCodeRefusedSignIn] = useState(false)
  const [openCodeSignInAdvice, setOpenCodeSignInAdvice] = useState<string | null>(null)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/health/opencode', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          setIsOpenCodeConnected(false)
          return
        }

        const payload = await res.json().catch(() => null) as { status?: string, failureKind?: string, advice?: unknown } | null
        const { status, failureKind, advice } = payload ?? {}
        setIsOpenCodeConnected(status === 'ok')
        setOpenCodeRefusedSignIn(failureKind === 'authentication')
        setOpenCodeSignInAdvice(getOpenCodeSignInAdvice(advice))
      })
      .catch((err) => { if (err.name !== 'AbortError') setIsOpenCodeConnected(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (isOpenCodeConnected !== true) return

    // The model query can race the OpenCode health check on mount.
    void refetchOpenCodeModelsQuery(queryClient)
  }, [isOpenCodeConnected, queryClient])

  const openCodeStatus = useMemo(() => getOpenCodeStatus(
    isOpenCodeConnected, models, [modelsLoading, modelsFetching, isRefreshingModels].some(Boolean), modelsError,
  ), [isOpenCodeConnected, models, modelsError, modelsFetching, modelsLoading, isRefreshingModels])

  const handleReloadModels = useCallback(async () => {
    setIsRefreshingModels(true)
    try {
      await refreshOpenCodeModelsQuery(queryClient)
    } catch (error) {
      addToast('error', describeQueryError(error) ?? 'Failed to reload OpenCode providers and models.', 5000)
    } finally {
      setIsRefreshingModels(false)
    }
  }, [addToast, queryClient])

  useEffect(() => {
    const err = createProfile.error || updateProfile.error
    if (!err) return

    const message = err instanceof Error ? err.message : 'Failed to save configuration'
    addToast('error', message, 5000)
  }, [createProfile.error, updateProfile.error, addToast])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (hasErrors) return
    const payload = buildProfilePayload(formData, rawNumeric, councilSlots, mainVariant, councilVariants)
    const submittedSnapshot = draftSnapshotRef.current
    const handleSuccess = () => {
      profileBaselineRef.current = submittedSnapshot
      const hasLaterEdits = draftSnapshotRef.current !== submittedSnapshot
      onDirtyChange?.(hasLaterEdits)
      addToast('success', 'Configuration saved.')
      if (!hasLaterEdits) onClose()
    }
    if (profile) {
      updateProfile.mutate(payload, { onSuccess: handleSuccess })
    } else {
      createProfile.mutate(payload, { onSuccess: handleSuccess })
    }
  }

  const updateField = <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }


  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <ProfileModelsSection
            formData={formData} updateField={updateField}
            councilSlots={councilSlots} setCouncilSlots={setCouncilSlots}
            mainVariant={mainVariant} setMainVariant={setMainVariant}
            councilVariants={councilVariants} setCouncilVariants={setCouncilVariants}
            modelVariantMap={modelVariantMap} models={models}
            modelsFetching={modelsFetching} isRefreshingModels={isRefreshingModels}
            handleReloadModels={handleReloadModels}
            isOpenCodeConnected={isOpenCodeConnected}
            openCodeRefusedSignIn={openCodeRefusedSignIn}
            openCodeSignInAdvice={openCodeSignInAdvice}
          />
          <Separator />

          <ProfileNumericSections rawNumeric={rawNumeric} onChange={(key, value) => setRawNumeric(previous => ({ ...previous, [key]: value }))} />

          <ProfileAdvancedSettings
            formData={formData} updateField={updateField}
            isOpen={isAdvancedOpen} onToggle={() => setIsAdvancedOpen(open => !open)}
            isWaitCustom={isAiQuestionWaitCustom}
            onWaitChange={value => {
              setIsAiQuestionWaitCustom(value !== null)
              updateField('aiQuestionWindow', value ?? PROFILE_DEFAULTS.aiQuestionWindow)
            }}
            hasWaitError={hasAiQuestionWaitError} onValidationChange={setHasAiQuestionWaitError}
            isLoading={profileLoading}
          />


          <ProfileConnectionStatus status={openCodeStatus} />
        </CardContent>
      </Card>

      <ProfileFormActions onOpenAbout={onOpenAbout} onClose={handleClose} isSaving={createProfile.isPending || updateProfile.isPending} hasErrors={hasErrors} />
    </form>
  )
}
