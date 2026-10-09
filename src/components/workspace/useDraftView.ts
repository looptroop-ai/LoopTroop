import { useEffect, useMemo, useRef, useState } from 'react'
import { useProfile, type Profile } from '@/hooks/useProfile'
import { useProjects, type Project } from '@/hooks/useProjects'
import { useTicketAction, useUpdateTicket, type Ticket } from '@/hooks/useTickets'
import { getProfileCouncil } from '@/lib/profileCouncil'
import { resolveManualQaSettingLabel } from '@/lib/manualQaSetting'
import { resolveAiQuestionsSettingLabel, resolveAiQuestionWindowLabel } from '@/lib/aiQuestionSetting'
import type { TicketDescriptionMode } from '@/components/ticket/TicketDescriptionTabs'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { normalizeString } from '@shared/typeGuards'

type DraftProfile = Profile | null | undefined

export const getDraftCouncilRaw = (profile: DraftProfile, project: Project | undefined) => (
  project?.councilMembers ?? profile?.councilMembers ?? null
)

export const getDraftCouncil = (profile: DraftProfile, project: Project | undefined) => {
  const mainImplementer = normalizeString(profile?.mainImplementer) ?? ''
  const configured = getProfileCouncil({ councilMembers: getDraftCouncilRaw(profile, project) }).members
  const members = [...new Set([mainImplementer, ...configured].map((member) => member.trim()).filter(Boolean))]
  return { members, highlightedMainImplementer: mainImplementer || members[0] || '' }
}

export const getDraftManualQaDefault = (profile: DraftProfile, project: Project | undefined) => resolveManualQaSettingLabel(
  null,
  project?.manualQaOverride ?? null,
  profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled,
)

export const getDraftAiQuestionsDefault = (profile: DraftProfile, project: Project | undefined) => resolveAiQuestionsSettingLabel(
  null,
  project?.aiQuestionsOverride,
  profile?.aiQuestionsEnabled ?? PROFILE_DEFAULTS.aiQuestionsEnabled,
)

export const getDraftAiQuestionWaitDefault = (profile: DraftProfile, project: Project | undefined) => resolveAiQuestionWindowLabel(
  null,
  project?.aiQuestionWindowOverride,
  profile?.aiQuestionWindow ?? PROFILE_DEFAULTS.aiQuestionWindow,
)

export const useDraftContext = (ticket: Ticket) => {
  const { data: projects = [], isLoading: isProjectsLoading } = useProjects()
  const { data: profile, isLoading: isProfileLoading } = useProfile()
  const project = projects.find((candidate) => candidate.id === ticket.projectId)
  const variants = useMemo(() => getProfileCouncil(profile).variants, [profile])
  return {
    project,
    isLoading: isProfileLoading || isProjectsLoading,
    isProfileLoading,
    council: { ...getDraftCouncil(profile, project), variants, mainImplementerVariant: profile?.mainImplementerVariant ?? null },
    inheritedManualQa: getDraftManualQaDefault(profile, project),
    inheritedAiQuestions: getDraftAiQuestionsDefault(profile, project),
    inheritedAiQuestionWindow: getDraftAiQuestionWaitDefault(profile, project),
  }
}

export type DraftContext = ReturnType<typeof useDraftContext>

export const getDraftErrorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export const formatDraftStartError = (message: string) => {
  const trimmed = message.trim() || 'Failed to start ticket.'
  if (trimmed.includes('configured in OpenCode')) {
    return `${trimmed} Update Configuration to choose currently available models, then try again.`
  }
  return trimmed
}

export const useDraftActions = (ticket: Ticket, startBlocked: boolean) => {
  const action = useTicketAction()
  const update = useUpdateTicket()
  const mutationInFlight = useRef(false)
  const [isStartAttemptActive, setIsStartAttemptActive] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const isBusy = action.isPending || update.isPending
  const isStartDisabled = isBusy || startBlocked
  const isMutationBlocked = () => isBusy || mutationInFlight.current

  const updateTicket = async (input: Parameters<typeof update.mutateAsync>[0]) => {
    // Query notifications are batched; blur and Start can run before the pending render.
    mutationInFlight.current = true
    try {
      return await update.mutateAsync(input)
    } finally {
      mutationInFlight.current = false
    }
  }

  const handleStart = () => {
    if (isStartDisabled || mutationInFlight.current) return
    mutationInFlight.current = true
    setIsStartAttemptActive(true)
    setStartError(null)
    action.mutate({ id: ticket.id, action: 'start' }, {
      onSuccess: () => setStartError(null),
      onError: (error) => setStartError(formatDraftStartError(getDraftErrorMessage(error, 'Failed to start ticket.'))),
      onSettled: () => { mutationInFlight.current = false },
    })
  }

  return { updateTicket, handleStart, isMutationBlocked, isBusy, isStartDisabled, isStarting: action.isPending, isSaving: update.isPending, isStartAttemptActive, startError }
}

export type DraftActions = ReturnType<typeof useDraftActions>

interface DraftSettingOptions<Value> {
  savedValue: Value | null | undefined
  onSave: (value: Value | null) => Promise<Ticket>
  disabled: boolean
  isMutationBlocked: () => boolean
  onError: (message: string | null) => void
  fallbackError: string
}

export const useDraftSetting = <Value extends boolean | number>(options: DraftSettingOptions<Value>) => {
  const savedValue = options.savedValue ?? null
  const [value, setValue] = useState(savedValue)
  useEffect(() => { setValue(savedValue) }, [savedValue])

  const onChange = async (next: Value | null) => {
    if (options.disabled || options.isMutationBlocked()) return
    const previous = value
    setValue(next)
    options.onError(null)
    try {
      await options.onSave(next)
    } catch (error) {
      setValue(previous)
      options.onError(getDraftErrorMessage(error, options.fallbackError))
    }
  }

  return { value, onChange }
}

export const useDraftDescription = (ticket: Ticket, actions: DraftActions) => {
  const savedDescription = ticket.description ?? ''
  const [text, setText] = useState(savedDescription)
  const [mode, setMode] = useState<TicketDescriptionMode>('markdown')
  const [isEditing, setIsEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedDescription, setLastSyncedDescription] = useState(savedDescription)
  const [shouldSkipNextSync, setShouldSkipNextSync] = useState(false)
  const hasDescriptionChanges = text !== savedDescription

  useEffect(() => {
    if (savedDescription === lastSyncedDescription) return
    setLastSyncedDescription(savedDescription)
    if (isEditing) return
    if (shouldSkipNextSync) {
      setShouldSkipNextSync(false)
      return
    }
    setText(savedDescription)
  }, [savedDescription, lastSyncedDescription, isEditing, shouldSkipNextSync])

  const handleEdit = () => {
    setText(savedDescription)
    setMode('raw')
    setError(null)
    setIsEditing(true)
  }

  const handleCancel = () => {
    setText(savedDescription)
    setError(null)
    setMode('markdown')
    setIsEditing(false)
  }

  const handleSave = async () => {
    if (actions.isMutationBlocked()) return
    if (!hasDescriptionChanges) {
      setMode('markdown')
      setIsEditing(false)
      return
    }
    setError(null)
    try {
      const updated = await actions.updateTicket({ id: ticket.id, description: text })
      setText(updated.description ?? text)
      setShouldSkipNextSync(true)
      setMode('markdown')
      setIsEditing(false)
    } catch (saveError) {
      setError(getDraftErrorMessage(saveError, 'Failed to save description.'))
    }
  }

  return {
    text, setText, mode, setMode, isEditing, error, handleEdit, handleCancel, handleSave,
    isSaving: actions.isSaving,
    isBusy: actions.isBusy,
    isSaveDisabled: actions.isBusy || !hasDescriptionChanges,
  }
}

export type DraftDescription = ReturnType<typeof useDraftDescription>
