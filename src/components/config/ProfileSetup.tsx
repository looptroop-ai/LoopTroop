import { useState, useEffect, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { LoadingText } from '@/components/ui/LoadingText'
import { ModelPicker } from './ModelPicker'
import { EffortPicker } from './EffortPicker'
import { OpenRouterRoutingPicker } from './OpenRouterRoutingPicker'
import type { OpenCodeModel } from '@/hooks/useOpenCodeModels'

function cleanModelId(id: string | null | undefined): string {
  if (id && id.startsWith('openrouter/')) {
    return id.split(':')[0]!
  }
  return id ?? ''
}

function parseOpenRouterModel(modelId: string | null | undefined) {
  const value = modelId ?? ''
  if (value.startsWith('openrouter/')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon > value.indexOf('/')) {
      return { base: value.substring(0, lastColon), suffix: value.substring(lastColon) }
    }
  }
  return { base: value, suffix: '' }
}

function isRouterModel(modelId: string | null | undefined, modelsList?: OpenCodeModel[]): boolean {
  const clean = cleanModelId(modelId)
  if (!clean.startsWith('openrouter/')) return false
  if (clean.startsWith('openrouter/openrouter/')) return true
  const found = modelsList?.find((model) => model.fullId === clean)
  return Boolean(found && found.name.toLowerCase().includes('router'))
}
import { useProfile, useCreateProfile, useUpdateProfile } from '@/hooks/useProfile'
import type { CreateProfileInput } from '@/hooks/useProfile'
import { Plus, X, RefreshCw } from 'lucide-react'
import { useToast } from '@/components/shared/useToast'
import { PROFILE_DEFAULTS } from '@server/db/defaults'
import { useQueryClient } from '@tanstack/react-query'
import { useOpenCodeModels, refetchOpenCodeModelsQuery, refreshOpenCodeModelsQuery } from '@/hooks/useOpenCodeModels'
import { numericFields, hasNumericErrors, buildInitialRawNumeric } from './numericFieldConfig'
import { NumericField } from './profileNumericUtils'
import { ConfigurationDocsLink } from './ConfigurationDocsLink'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { GitHookPolicySetting } from '@/components/git-hooks/GitHookPolicySetting'

interface ProfileSetupProps {
  onClose: () => void
  onOpenAbout?: () => void
}

const descriptionDocs = {
  mainImplementer: '/configuration#main-implementer-model',
  councilMembers: '/configuration#council-members',
} as const

export function ProfileSetup({ onClose, onOpenAbout = () => undefined }: ProfileSetupProps) {
  const { data: profile } = useProfile()
  const createProfile = useCreateProfile()
  const updateProfile = useUpdateProfile()
  const { addToast } = useToast()
  const queryClient = useQueryClient()

  const [formData, setFormData] = useState<CreateProfileInput>({
    mainImplementer: profile?.mainImplementer ?? '',
    minCouncilQuorum: profile?.minCouncilQuorum ?? PROFILE_DEFAULTS.minCouncilQuorum,
    perIterationTimeout: profile?.perIterationTimeout ?? PROFILE_DEFAULTS.perIterationTimeout,
    executionSetupTimeout: profile?.executionSetupTimeout ?? PROFILE_DEFAULTS.executionSetupTimeout,
    councilResponseTimeout: profile?.councilResponseTimeout ?? PROFILE_DEFAULTS.councilResponseTimeout,
    interviewQuestions: profile?.interviewQuestions ?? PROFILE_DEFAULTS.interviewQuestions,
    coverageFollowUpBudgetPercent: profile?.coverageFollowUpBudgetPercent ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
    maxCoveragePasses: profile?.maxCoveragePasses ?? PROFILE_DEFAULTS.maxCoveragePasses,
    maxPrdCoveragePasses: profile?.maxPrdCoveragePasses ?? PROFILE_DEFAULTS.maxPrdCoveragePasses,
    maxBeadsCoveragePasses: profile?.maxBeadsCoveragePasses ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses,
    structuredRetryCount: profile?.structuredRetryCount ?? PROFILE_DEFAULTS.structuredRetryCount,
    maxIterations: profile?.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
    opencodeRetryLimit: profile?.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit,
    opencodeRetryDelay: profile?.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay,
    opencodeSteps: profile?.opencodeSteps ?? PROFILE_DEFAULTS.opencodeSteps,
    toolInputMaxChars: profile?.toolInputMaxChars ?? PROFILE_DEFAULTS.toolInputMaxChars,
    toolOutputMaxChars: profile?.toolOutputMaxChars ?? PROFILE_DEFAULTS.toolOutputMaxChars,
    toolErrorMaxChars: profile?.toolErrorMaxChars ?? PROFILE_DEFAULTS.toolErrorMaxChars,
    manualQaEnabled: profile?.manualQaEnabled ?? false,
    gitHookPolicy: profile?.gitHookPolicy ?? 'validate_explicitly',
  })

  const [rawNumeric, setRawNumeric] = useState<Record<string, string>>(() => buildInitialRawNumeric({ ...formData }))

  const hasErrors = hasNumericErrors(rawNumeric)

  const [councilSlots, setCouncilSlots] = useState<string[]>([])

  // Variant state: per-model variant selections
  const [mainVariant, setMainVariant] = useState<string | undefined>(undefined)
  const [councilVariants, setCouncilVariants] = useState<Record<string, string>>({})

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
  // Sync form state when profile data loads
  useEffect(() => {
    if (!profile) return
    setFormData({
      mainImplementer: profile.mainImplementer ?? '',
      minCouncilQuorum: profile.minCouncilQuorum ?? PROFILE_DEFAULTS.minCouncilQuorum,
      perIterationTimeout: profile.perIterationTimeout ?? PROFILE_DEFAULTS.perIterationTimeout,
      executionSetupTimeout: profile.executionSetupTimeout ?? PROFILE_DEFAULTS.executionSetupTimeout,
      councilResponseTimeout: profile.councilResponseTimeout ?? PROFILE_DEFAULTS.councilResponseTimeout,
      interviewQuestions: profile.interviewQuestions ?? PROFILE_DEFAULTS.interviewQuestions,
      coverageFollowUpBudgetPercent: profile.coverageFollowUpBudgetPercent ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
      maxCoveragePasses: profile.maxCoveragePasses ?? PROFILE_DEFAULTS.maxCoveragePasses,
      maxPrdCoveragePasses: profile.maxPrdCoveragePasses ?? PROFILE_DEFAULTS.maxPrdCoveragePasses,
      maxBeadsCoveragePasses: profile.maxBeadsCoveragePasses ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses,
      structuredRetryCount: profile.structuredRetryCount ?? PROFILE_DEFAULTS.structuredRetryCount,
      maxIterations: profile.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
      opencodeRetryLimit: profile.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit,
      opencodeRetryDelay: profile.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay,
      opencodeSteps: profile.opencodeSteps ?? PROFILE_DEFAULTS.opencodeSteps,
      toolInputMaxChars: profile.toolInputMaxChars ?? PROFILE_DEFAULTS.toolInputMaxChars,
      toolOutputMaxChars: profile.toolOutputMaxChars ?? PROFILE_DEFAULTS.toolOutputMaxChars,
      toolErrorMaxChars: profile.toolErrorMaxChars ?? PROFILE_DEFAULTS.toolErrorMaxChars,
      manualQaEnabled: profile.manualQaEnabled ?? false,
      gitHookPolicy: profile.gitHookPolicy ?? 'validate_explicitly',
    })
    setRawNumeric(buildInitialRawNumeric({
      perIterationTimeout: profile.perIterationTimeout ?? PROFILE_DEFAULTS.perIterationTimeout,
      executionSetupTimeout: profile.executionSetupTimeout ?? PROFILE_DEFAULTS.executionSetupTimeout,
      councilResponseTimeout: profile.councilResponseTimeout ?? PROFILE_DEFAULTS.councilResponseTimeout,
      maxIterations: profile.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
      minCouncilQuorum: profile.minCouncilQuorum ?? PROFILE_DEFAULTS.minCouncilQuorum,
      interviewQuestions: profile.interviewQuestions ?? PROFILE_DEFAULTS.interviewQuestions,
      coverageFollowUpBudgetPercent: profile.coverageFollowUpBudgetPercent ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
      maxCoveragePasses: profile.maxCoveragePasses ?? PROFILE_DEFAULTS.maxCoveragePasses,
      maxPrdCoveragePasses: profile.maxPrdCoveragePasses ?? PROFILE_DEFAULTS.maxPrdCoveragePasses,
      maxBeadsCoveragePasses: profile.maxBeadsCoveragePasses ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses,
      structuredRetryCount: profile.structuredRetryCount ?? PROFILE_DEFAULTS.structuredRetryCount,
      opencodeRetryLimit: profile.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit,
      opencodeRetryDelay: profile.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay,
      opencodeSteps: profile.opencodeSteps ?? PROFILE_DEFAULTS.opencodeSteps,
      toolInputMaxChars: profile.toolInputMaxChars ?? PROFILE_DEFAULTS.toolInputMaxChars,
      toolOutputMaxChars: profile.toolOutputMaxChars ?? PROFILE_DEFAULTS.toolOutputMaxChars,
      toolErrorMaxChars: profile.toolErrorMaxChars ?? PROFILE_DEFAULTS.toolErrorMaxChars,
    }))
    // Restore variant state
    setMainVariant(profile.mainImplementerVariant ?? undefined)
    try {
      const parsed = profile.councilMemberVariants ? JSON.parse(profile.councilMemberVariants) : {}
      const cleanedVariants: Record<string, string> = {}
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          cleanedVariants[cleanModelId(k)] = v as string
        }
      }
      setCouncilVariants(cleanedVariants)
    } catch {
      setCouncilVariants({})
    }
    try {
      const council: string[] = profile.councilMembers ? JSON.parse(profile.councilMembers) : []
      setCouncilSlots(council.filter(id => id !== profile.mainImplementer))
    } catch {
      setCouncilSlots([])
    }
  }, [profile])

  const [isOpenCodeConnected, setIsOpenCodeConnected] = useState<boolean | null>(null)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/health/opencode', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          setIsOpenCodeConnected(false)
          return
        }

        const payload = await res.json().catch(() => null) as { status?: string } | null
        setIsOpenCodeConnected(payload?.status === 'ok')
      })
      .catch((err) => { if (err.name !== 'AbortError') setIsOpenCodeConnected(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (isOpenCodeConnected !== true) return

    // The model query can race the OpenCode health check on mount.
    void refetchOpenCodeModelsQuery(queryClient)
  }, [isOpenCodeConnected, queryClient])

  const openCodeStatus = useMemo(() => {
    if (isOpenCodeConnected === null) return null
    if (isOpenCodeConnected === false) {
      return { dotClass: 'bg-red-500', label: 'OpenCode not connected' }
    }
    if (modelsError && !modelsFetching) {
      return { dotClass: 'bg-amber-500', label: 'OpenCode connected, but model discovery failed' }
    }
    if (modelsLoading || modelsFetching) {
      return { dotClass: 'bg-amber-500', label: 'OpenCode connected, checking models…' }
    }
    if ((models?.length ?? 0) === 0) {
      return { dotClass: 'bg-amber-500', label: 'OpenCode connected, but no models are available' }
    }
    return { dotClass: 'bg-green-500', label: 'OpenCode connected and working' }
  }, [isOpenCodeConnected, models, modelsError, modelsFetching, modelsLoading])

  const handleReloadModels = useCallback(async () => {
    setIsRefreshingModels(true)
    try {
      await refreshOpenCodeModelsQuery(queryClient)
    } finally {
      setIsRefreshingModels(false)
    }
  }, [queryClient])

  useEffect(() => {
    const err = createProfile.error || updateProfile.error
    if (!err) return

    const message = err instanceof Error ? err.message : 'Failed to save configuration'
    addToast('error', message, 5000)
  }, [createProfile.error, updateProfile.error, addToast])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (hasErrors) return
    // Build payload with validated numeric values
    const validatedData = { ...formData }
    for (const [key, cfg] of Object.entries(numericFields)) {
      const n = Number(rawNumeric[key]);
      (validatedData as Record<string, unknown>)[key] = cfg.toStore(n)
    }
    const allCouncil = [validatedData.mainImplementer, ...councilSlots].filter((value): value is string => Boolean(value))
    const uniqueCouncil = [...new Set(allCouncil)]
    // Build council member variants map (only for members with a variant set)
    const variantsMap: Record<string, string> = {}
    for (const modelId of uniqueCouncil) {
      if (modelId === validatedData.mainImplementer) continue
      const v = councilVariants[cleanModelId(modelId)]
      if (v && v !== 'none') variantsMap[modelId] = v
    }
    const payload: CreateProfileInput = {
      ...validatedData,
      councilMembers: JSON.stringify(uniqueCouncil),
      mainImplementerVariant: mainVariant && mainVariant !== 'none' ? mainVariant : '',
      councilMemberVariants: Object.keys(variantsMap).length > 0 ? JSON.stringify(variantsMap) : '',
    }
    const handleSuccess = () => {
      addToast('success', 'Configuration saved.')
      onClose()
    }
    if (profile) {
      updateProfile.mutate(payload, { onSuccess: handleSuccess })
    } else {
      createProfile.mutate(payload, { onSuccess: handleSuccess })
    }
  }

  const updateField = <K extends keyof CreateProfileInput>(key: K, value: CreateProfileInput[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }
  const mainImplementerVariantLabel = mainVariant && mainVariant !== 'none' ? mainVariant : 'None'

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          {/* ── AI Models ── */}
          <div className="flex items-center gap-1.5 mb-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">AI Models</div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  id="reload-opencode-models"
                  onClick={() => { void handleReloadModels() }}
                  disabled={modelsFetching || isRefreshingModels}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Reload OpenCode providers and models"
                >
                  <RefreshCw className={`h-3 w-3 ${modelsFetching || isRefreshingModels ? 'animate-spin' : ''}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reload OpenCode providers and models</TooltipContent>
            </Tooltip>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1" htmlFor="main-implementer">
              Main Implementer Model
            </label>
            <div className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <p className="min-w-0 flex-1">Primary model used for code generation and implementation</p>
              <ConfigurationDocsLink
                docsPath={descriptionDocs.mainImplementer}
                label="Main Implementer Model"
                description="Select the primary model that writes and implements code. You can choose any available OpenCode model. Open the detailed documentation."
              />
            </div>
            <ModelPicker
              value={formData.mainImplementer ?? ''}
              onChange={v => {
                updateField('mainImplementer', v)
                setMainVariant(undefined)
              }}
              disabledValues={councilSlots.filter(Boolean)}
            />
            {formData.mainImplementer && (
              <div className="mt-1.5 space-y-1.5">
                <EffortPicker
                  variants={modelVariantMap.get(cleanModelId(formData.mainImplementer))}
                  value={mainVariant}
                  onChange={setMainVariant}
                />
                {formData.mainImplementer.startsWith('openrouter/') && !isRouterModel(formData.mainImplementer, models) && (() => {
                  const { base, suffix } = parseOpenRouterModel(formData.mainImplementer)
                  return <OpenRouterRoutingPicker value={suffix} onChange={(nextSuffix) => updateField('mainImplementer', base + nextSuffix)} />
                })()}
              </div>
            )}
            {isOpenCodeConnected === false && (
              <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                LoopTroop could not reach the configured OpenCode server. Start it with <code className="font-mono bg-muted-foreground/10 px-1 rounded">opencode serve</code> or check the backend OpenCode URL.
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Council Members</label>
            <div className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <p className="min-w-0 flex-1">
                Choose up to 10 models to form the review council. The main implementer is automatically included.
              </p>
              <ConfigurationDocsLink
                docsPath={descriptionDocs.councilMembers}
                label="Council Members"
                description="Choose the models that review plans and proposals alongside the main implementer. You can select up to nine additional models. Open the detailed documentation."
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-lg border border-input bg-muted/40 px-3 py-2.5 text-sm">
                  <span className="font-medium">{formData.mainImplementer || '(select main implementer above)'}</span>
                  {formData.mainImplementer && (
                    <span className="ml-2 text-[10px] text-muted-foreground">· {mainImplementerVariantLabel}</span>
                  )}
                  <span className="ml-2 text-[10px] text-muted-foreground">MAI — auto-included</span>
                </div>
              </div>
              {councilSlots.map((slot, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1 space-y-1.5">
                    <ModelPicker
                      value={slot}
                      onChange={v => {
                        setCouncilSlots(prev => prev.map((s, j) => j === i ? v : s))
                        const cleanSlot = cleanModelId(slot)
                        if (slot && slot !== v) {
                          setCouncilVariants(prev => {
                            const next = { ...prev }
                            delete next[cleanSlot]
                            return next
                          })
                        }
                      }}
                      placeholder={`Council member ${i + 2}…`}
                      disabledValues={[formData.mainImplementer, ...councilSlots.filter((_, j) => j !== i)].filter(Boolean) as string[]}
                    />
                    {slot && (
                      <div className="space-y-1.5">
                        <EffortPicker
                          variants={modelVariantMap.get(cleanModelId(slot))}
                          value={councilVariants[cleanModelId(slot)]}
                          onChange={v => setCouncilVariants(prev => {
                            const next = { ...prev }
                            const cleanSlot = cleanModelId(slot)
                            if (v) next[cleanSlot] = v
                            else delete next[cleanSlot]
                            return next
                          })}
                        />
                        {slot.startsWith('openrouter/') && !isRouterModel(slot, models) && (() => {
                          const { base, suffix } = parseOpenRouterModel(slot)
                          return <OpenRouterRoutingPicker value={suffix} onChange={(nextSuffix) => {
                            setCouncilSlots((previous) => previous.map((value, index) => index === i ? base + nextSuffix : value))
                          }} />
                        })()}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const removedSlot = councilSlots[i]
                      setCouncilSlots(prev => prev.filter((_, j) => j !== i))
                      if (removedSlot) {
                        setCouncilVariants(prev => {
                          const next = { ...prev }
                          delete next[cleanModelId(removedSlot)]
                          return next
                        })
                      }
                    }}
                    className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label={`Remove council member ${i + 2}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {councilSlots.length < 9 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCouncilSlots(prev => [...prev, ''])}
                  className="gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Council Member
                </Button>
              )}
              {councilSlots.filter(Boolean).length < 1 && (
                <p className="text-xs text-amber-600">
                  Add at least 1 more council member (MAI + 1 minimum).
                </p>
              )}
            </div>
          </div>

          <Separator />

          {/* ── OpenCode Provider Recovery ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">OpenCode Provider Recovery</div>
          <p className="mb-3 text-xs text-muted-foreground">
            Handles OpenCode rate-limit, usage-limit, overload, timeout, and network retry events across all phases.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumericField fieldKey="opencodeRetryLimit" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Continuable OpenCode retry events before blocking any phase prompt (0–50)." />
            <NumericField fieldKey="opencodeRetryDelay" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum OpenCode retry grace window before blocking any phase prompt (0–3600s)." />
            <NumericField fieldKey="opencodeSteps" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Max steps per OpenCode session (0 = no limit, OpenCode default). Each step ≈ 2 messages in the log." />
          </div>

          <Separator />

          {/* ── AI Thinking ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">AI Thinking</div>
          <div className="grid grid-cols-2 gap-3">
            <NumericField
              fieldKey="councilResponseTimeout"
              rawNumeric={rawNumeric}
              onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))}
              hint="Wait time for planning and other AI-only responses (10–3600s)."
              tooltip="Applies to planning and other AI-only responses. It does not apply to coding attempts or pre-implementation workspace setup; use Per-Iteration Timeout and Execution Setup Timeout for those."
            />
            <NumericField fieldKey="minCouncilQuorum" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Minimum council votes required (1–6)" />
          </div>
          <div className="mt-3">
            <NumericField fieldKey="interviewQuestions" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum initial clarifying questions (0–50; keep above 0 for normal runs)." />
          </div>
          <div className="mt-3">
            <NumericField fieldKey="structuredRetryCount" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Retries after invalid structured output (0–5)." />
          </div>

          <Separator />

          {/* ── Coverage ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Coverage</div>
          <div className="grid grid-cols-2 gap-3">
            <NumericField fieldKey="coverageFollowUpBudgetPercent" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum interview follow-up budget for interview coverage passes (0–100%)." />
            <NumericField fieldKey="maxCoveragePasses" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Interview coverage executions allowed before approval fallback (1–10)." />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <NumericField fieldKey="maxPrdCoveragePasses" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum PRD coverage executions before approval fallback (2–20)." />
            <NumericField fieldKey="maxBeadsCoveragePasses" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum beads coverage executions before approval fallback (2–20)." />
          </div>

          <Separator />

          {/* ── Pre-Implementation ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Pre-Implementation</div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium">Git hook policy</label>
                <ConfigurationDocsLink
                  docsPath="/configuration#git-hook-policy"
                  label="Git hook policy"
                  description="Choose how LoopTroop handles repository hooks before implementation. Open the Git hook policy documentation."
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose how LoopTroop handles repository hooks.
              </p>
            </div>
            <GitHookPolicySetting
              value={formData.gitHookPolicy ?? 'validate_explicitly'}
              onChange={(value) => updateField('gitHookPolicy', value)}
              compact
            />
          </div>

          <Separator />

          {/* ── Implementation & Workspace Setup ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Implementation &amp; Workspace Setup</div>
          <div className="grid grid-cols-2 gap-3">
            <NumericField fieldKey="maxIterations" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Maximum automatic retries per bead during coding (0–20). Final test retries use the same limit." />
            <NumericField fieldKey="perIterationTimeout" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Timeout for each attempt (10–3600s)" />
          </div>
          <div className="mt-3">
            <NumericField
              fieldKey="executionSetupTimeout"
              rawNumeric={rawNumeric}
              onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))}
              hint="Total active-work budget for each workspace setup attempt before coding starts (0–3600s)."
              tooltip="This is the maximum total active-work time for one pre-implementation workspace setup attempt. Progress continuations and result corrections share the same budget; every genuine retry receives a fresh full budget."
            />
          </div>

          <Separator />

          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Post-Implementation</div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium">Manual QA checkpoint</label>
                <ConfigurationDocsLink
                  docsPath="/configuration#manual-qa"
                  label="Manual QA checkpoint"
                  description="Set whether tickets pause for your verification after final tests. Open the Manual QA documentation."
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                When enabled, new tickets pause after final tests with a generated checklist. LoopTroop never starts or controls your application.
              </p>
            </div>
            <ManualQaSetting
              idPrefix="profile-manual-qa"
              value={formData.manualQaEnabled ? true : false}
              onChange={(value) => updateField('manualQaEnabled', value === true)}
              compact
            />
          </div>

          <Separator />

          {/* ── Logging ── */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Logging</div>
          <div className="grid grid-cols-2 gap-3">
            <NumericField fieldKey="toolInputMaxChars" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Max characters for tool input in logs (500–50K)." />
            <NumericField fieldKey="toolOutputMaxChars" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Max characters for tool output in logs (1K–100K)." />
            <NumericField fieldKey="toolErrorMaxChars" rawNumeric={rawNumeric} onChange={(k, v) => setRawNumeric(prev => ({ ...prev, [k]: v }))} hint="Max characters for tool error in logs (500–50K)." />
          </div>


          {openCodeStatus && (
            <>
              <Separator />
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${openCodeStatus.dotClass}`} />
                <span className="text-xs text-muted-foreground">{openCodeStatus.label}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onOpenAbout} className="rounded-lg text-muted-foreground hover:text-foreground">
          About
        </Button>
        <div className="flex items-center gap-2.5">
          <Button type="button" variant="outline" onClick={onClose} className="rounded-lg">
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={createProfile.isPending || updateProfile.isPending || hasErrors}
            className="rounded-lg bg-foreground text-background font-semibold hover:opacity-95 active:scale-[0.98] shadow-2xs"
          >
            {createProfile.isPending || updateProfile.isPending ? <LoadingText text="Saving" /> : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  )
}
