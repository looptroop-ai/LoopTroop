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
  const pendingUpdate = useRef<Promise<Ticket> | null>(null)
  const startInFlight = useRef(false)
  const [isStartQueued, setIsStartQueued] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isStartAttemptActive, setIsStartAttemptActive] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const isStarting = action.isPending || isStartQueued
  const isStartDisabled = isStarting || startBlocked

  const updateTicket = (input: Parameters<typeof update.mutateAsync>[0]) => {
    // Serialize blur and the following activation; a failed save cancels its queued actions.
    const saved = pendingUpdate.current
      ? pendingUpdate.current.then(() => update.mutateAsync(input))
      : update.mutateAsync(input)
    pendingUpdate.current = saved
    setIsSaving(true)
    const finish = () => {
      if (pendingUpdate.current !== saved) return
      pendingUpdate.current = null
      setIsSaving(false)
    }
    void saved.then(finish, finish)
    return saved
  }

  const handleStart = async () => {
    if (startBlocked || startInFlight.current) return
    startInFlight.current = true
    setIsStartQueued(true)
    setStartError(null)
    try {
      if (pendingUpdate.current) await pendingUpdate.current
      setIsStartAttemptActive(true)
      await action.mutateAsync({ id: ticket.id, action: 'start' })
    } catch (error) {
      setStartError(formatDraftStartError(getDraftErrorMessage(error, 'Failed to start ticket.')))
    } finally {
      startInFlight.current = false
      setIsStartQueued(false)
    }
  }

  return { updateTicket, handleStart, isStartDisabled, isStarting, isSaving, isStartAttemptActive, startError }
}

export type DraftActions = ReturnType<typeof useDraftActions>

interface DraftSettingOptions<Value> {
  savedValue: Value | null | undefined
  onSave: (value: Value | null) => Promise<Ticket>
  disabled: boolean
  onError: (message: string | null) => void
  fallbackError: string
}

export const useDraftSetting = <Value extends boolean | number>(options: DraftSettingOptions<Value>) => {
  const savedValue = options.savedValue ?? null
  const [value, setValue] = useState(savedValue)
  const lastSavedValue = useRef(savedValue)
  const pendingCount = useRef(0)
  const latestRequest = useRef(0)
  useEffect(() => {
    lastSavedValue.current = savedValue
    if (pendingCount.current === 0) setValue(savedValue)
  }, [savedValue])

  const onChange = async (next: Value | null) => {
    if (options.disabled || next === value) return
    const request = ++latestRequest.current
    pendingCount.current += 1
    setValue(next)
    options.onError(null)
    try {
      await options.onSave(next)
      lastSavedValue.current = next
    } catch (error) {
      if (request === latestRequest.current) {
        setValue(lastSavedValue.current)
        options.onError(getDraftErrorMessage(error, options.fallbackError))
      }
    } finally {
      pendingCount.current -= 1
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
  const [isSaving, setIsSaving] = useState(false)
  const [lastSyncedDescription, setLastSyncedDescription] = useState(savedDescription)
  const [shouldSkipNextSync, setShouldSkipNextSync] = useState(false)
  const hasDescriptionChanges = text !== savedDescription
  const isBusy = actions.isStarting || isSaving

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
    if (isBusy) return
    if (!hasDescriptionChanges) {
      setMode('markdown')
      setIsEditing(false)
      return
    }
    setError(null)
    setIsSaving(true)
    try {
      const updated = await actions.updateTicket({ id: ticket.id, description: text })
      setText(updated.description ?? text)
      setShouldSkipNextSync(true)
      setMode('markdown')
      setIsEditing(false)
    } catch (saveError) {
      setError(getDraftErrorMessage(saveError, 'Failed to save description.'))
    } finally {
      setIsSaving(false)
    }
  }

  return {
    text, setText, mode, setMode, isEditing, error, handleEdit, handleCancel, handleSave,
    isSaving,
    isBusy,
    isSaveDisabled: isBusy || !hasDescriptionChanges,
  }
}

export type DraftDescription = ReturnType<typeof useDraftDescription>
