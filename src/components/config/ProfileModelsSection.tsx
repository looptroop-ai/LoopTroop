import type { Dispatch, SetStateAction } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { OpenCodeModel } from '@/hooks/useOpenCodeModels'
import { ConfigurationDocsLink } from './ConfigurationDocsLink'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'
import { OpenRouterRoutingPicker } from './OpenRouterRoutingPicker'
import { cleanModelId, type ProfileFormData } from './profileFormData'

interface ProfileModelsSectionProps {
  formData: ProfileFormData
  updateField: <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => void
  councilSlots: string[]
  setCouncilSlots: Dispatch<SetStateAction<string[]>>
  mainVariant: string | undefined
  setMainVariant: Dispatch<SetStateAction<string | undefined>>
  councilVariants: Record<string, string>
  setCouncilVariants: Dispatch<SetStateAction<Record<string, string>>>
  modelVariantMap: Map<string, Record<string, Record<string, unknown>>>
  models: OpenCodeModel[] | undefined
  modelsFetching: boolean
  isRefreshingModels: boolean
  handleReloadModels: () => Promise<void>
  isOpenCodeConnected: boolean | null
  openCodeRefusedSignIn: boolean
  openCodeSignInAdvice: string | null
}

/** For a `/health/opencode` refusal that arrives without the backend's advice. */
const REFUSED_SIGN_IN_FALLBACK = 'OpenCode is running but refused LoopTroop\'s sign-in. '
  + 'Set `OPENCODE_PASSWORD` to that server\'s password, then run `looptroop restart`.'

/** The server's advice quotes commands and variables in backticks; show those as code. */
const renderBacktickCode = (text: string) => text.split('`').map((part, index) => index % 2 === 1
  ? <code key={index} className="font-mono bg-muted-foreground/10 px-1 rounded">{part}</code>
  : part)

const parseOpenRouterModel = (modelId: string) => {
  if (modelId.startsWith('openrouter/')) {
    const lastColon = modelId.lastIndexOf(':')
    if (lastColon > modelId.indexOf('/')) {
      return { base: modelId.substring(0, lastColon), suffix: modelId.substring(lastColon) }
    }
  }
  return { base: modelId, suffix: '' }
}

const isRouterModel = (modelId: string, models: OpenCodeModel[] | undefined): boolean => {
  const clean = cleanModelId(modelId)
  if (!clean.startsWith('openrouter/')) return false
  if (clean.startsWith('openrouter/openrouter/')) return true
  const found = models?.find(model => model.fullId === clean)
  return Boolean(found && found.name.toLowerCase().includes('router'))
}

type ModelsHeaderProps = Pick<ProfileModelsSectionProps, 'modelsFetching' | 'isRefreshingModels' | 'handleReloadModels'>

const ModelsReloadButton = ({ modelsFetching, isRefreshingModels, handleReloadModels }: ModelsHeaderProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        id="reload-opencode-models"
        onClick={() => { void handleReloadModels() }}
        disabled={isRefreshingModels}
        className="p-0.5 rounded text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Reload OpenCode providers and models"
      >
        <RefreshCw className={`h-3 w-3 ${modelsFetching || isRefreshingModels ? 'animate-spin' : ''}`} />
      </button>
    </TooltipTrigger>
    <TooltipContent>Reload OpenCode providers and models</TooltipContent>
  </Tooltip>
)

const ModelsHeader = (props: ModelsHeaderProps) => (
  <div className="flex items-center gap-1.5 mb-2">
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">AI Models</div>
    <ModelsReloadButton {...props} />
  </div>
)

interface ModelRoutingProps {
  modelId: string
  models: OpenCodeModel[] | undefined
  onChange: (modelId: string) => void
}

const ModelRouting = ({ modelId, models, onChange }: ModelRoutingProps) => {
  if (!modelId.startsWith('openrouter/') || isRouterModel(modelId, models)) return null
  const { base, suffix } = parseOpenRouterModel(modelId)
  return <OpenRouterRoutingPicker value={suffix} onChange={nextSuffix => onChange(base + nextSuffix)} />
}

interface ModelOptionsProps extends Pick<ProfileModelsSectionProps, 'modelVariantMap' | 'models'> {
  modelId: string
  variant: string | undefined
  onVariantChange: (variant: string | undefined) => void
  onRoutingChange: (modelId: string) => void
  className: string
}

const ModelOptions = ({ modelId, variant, onVariantChange, onRoutingChange, modelVariantMap, models, className }: ModelOptionsProps) => {
  if (!modelId) return null
  return (
    <div className={className}>
      <EffortPicker
        variants={modelVariantMap.get(cleanModelId(modelId))}
        value={variant}
        onChange={onVariantChange}
      />
      <ModelRouting modelId={modelId} models={models} onChange={onRoutingChange} />
    </div>
  )
}

type OpenCodeAdviceProps = Pick<ProfileModelsSectionProps, 'isOpenCodeConnected' | 'openCodeRefusedSignIn' | 'openCodeSignInAdvice'>

const OpenCodeUnreachableAdvice = () => (
  <>LoopTroop could not reach its OpenCode server. Restart LoopTroop (<code className="font-mono bg-muted-foreground/10 px-1 rounded">looptroop restart</code>) so it starts OpenCode again, or check the backend OpenCode URL.</>
)

const OpenCodeConnectionAdvice = ({ isOpenCodeConnected, openCodeRefusedSignIn, openCodeSignInAdvice }: OpenCodeAdviceProps) => {
  if (isOpenCodeConnected !== false) return null
  return (
    <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      {openCodeRefusedSignIn
        ? renderBacktickCode(openCodeSignInAdvice ?? REFUSED_SIGN_IN_FALLBACK)
        : <OpenCodeUnreachableAdvice />}
    </div>
  )
}

type MainImplementerProps = Pick<ProfileModelsSectionProps,
  'formData' | 'updateField' | 'councilSlots' | 'mainVariant' | 'setMainVariant' | 'modelVariantMap' | 'models' | 'isRefreshingModels'
> & OpenCodeAdviceProps

const MainImplementerSection = ({ formData, updateField, councilSlots, mainVariant, setMainVariant, modelVariantMap, models, isRefreshingModels, ...advice }: MainImplementerProps) => (
  <div>
    <label className="text-sm font-medium block mb-1" htmlFor="main-implementer">
      Main Implementer Model
    </label>
    <div className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground">
      <p className="min-w-0 flex-1">Primary model used for code generation and implementation</p>
      <ConfigurationDocsLink
        docsPath="/configuration#main-implementer-model"
        label="Main Implementer Model"
        description="Select the primary model that writes and implements code. You can choose any available OpenCode model. Open the detailed documentation."
      />
    </div>
    <ModelPicker
      isRefreshing={isRefreshingModels}
      id="main-implementer"
      label="Main Implementer Model"
      value={formData.mainImplementer ?? ''}
      onChange={value => {
        updateField('mainImplementer', value)
        setMainVariant(undefined)
      }}
      disabledValues={councilSlots.filter(Boolean)}
    />
    <ModelOptions
      modelId={formData.mainImplementer}
      variant={mainVariant}
      onVariantChange={setMainVariant}
      onRoutingChange={modelId => updateField('mainImplementer', modelId)}
      modelVariantMap={modelVariantMap}
      models={models}
      className="mt-1.5 space-y-1.5"
    />
    <OpenCodeConnectionAdvice {...advice} />
  </div>
)

interface MainImplementerCouncilProps {
  mainImplementer: string
  mainVariant: string | undefined
}

const MainImplementerCouncilRow = ({ mainImplementer, mainVariant }: MainImplementerCouncilProps) => {
  const variantLabel = mainVariant && mainVariant !== 'none' ? mainVariant : 'None'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 rounded-lg border border-input bg-muted/40 px-3 py-2.5 text-sm">
        <span className="font-medium">{mainImplementer || '(select main implementer above)'}</span>
        {mainImplementer && (
          <span className="ml-2 text-[10px] text-muted-foreground">· {variantLabel}</span>
        )}
        <span className="ml-2 text-[10px] text-muted-foreground">MAI (auto-included)</span>
      </div>
    </div>
  )
}

type CouncilModelsProps = Pick<ProfileModelsSectionProps,
  'formData' | 'councilSlots' | 'setCouncilSlots' | 'councilVariants' | 'setCouncilVariants' | 'modelVariantMap' | 'models' | 'isRefreshingModels'
>

interface CouncilMemberProps extends CouncilModelsProps {
  slot: string
  index: number
}

const CouncilMemberRow = ({ slot, index, formData, councilSlots, setCouncilSlots, councilVariants, setCouncilVariants, modelVariantMap, models, isRefreshingModels }: CouncilMemberProps) => {
  const updateModel = (modelId: string) => {
    setCouncilSlots(previous => previous.map((value, position) => position === index ? modelId : value))
    if (slot && slot !== modelId) {
      setCouncilVariants(previous => {
        const next = { ...previous }
        delete next[cleanModelId(slot)]
        return next
      })
    }
  }
  const updateVariant = (variant: string | undefined) => setCouncilVariants(previous => {
    const next = { ...previous }
    const cleanSlot = cleanModelId(slot)
    if (variant) next[cleanSlot] = variant
    else delete next[cleanSlot]
    return next
  })
  const updateRouting = (modelId: string) => {
    setCouncilSlots(previous => previous.map((value, position) => position === index ? modelId : value))
  }
  const removeMember = () => {
    setCouncilSlots(previous => previous.filter((_, position) => position !== index))
    if (slot) {
      setCouncilVariants(previous => {
        const next = { ...previous }
        delete next[cleanModelId(slot)]
        return next
      })
    }
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 space-y-1.5">
        <ModelPicker
          isRefreshing={isRefreshingModels}
          value={slot}
          onChange={updateModel}
          label={`Council member ${index + 2}`}
          placeholder={`Council member ${index + 2}…`}
          disabledValues={[formData.mainImplementer, ...councilSlots.filter((_, position) => position !== index)].filter(Boolean)}
        />
        <ModelOptions
          modelId={slot}
          variant={councilVariants[cleanModelId(slot)]}
          onVariantChange={updateVariant}
          onRoutingChange={updateRouting}
          modelVariantMap={modelVariantMap}
          models={models}
          className="space-y-1.5"
        />
      </div>
      <button
        type="button"
        onClick={removeMember}
        className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        aria-label={`Remove council member ${index + 2}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

type CouncilSectionProps = CouncilModelsProps & Pick<ProfileModelsSectionProps, 'mainVariant'>

const CouncilMembersSection = (props: CouncilSectionProps) => {
  const { formData, councilSlots, setCouncilSlots, mainVariant } = props
  return (
    <div>
      <label className="text-sm font-medium block mb-1">Council Members</label>
      <div className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground">
        <p className="min-w-0 flex-1">
          Choose up to 10 models to form the review council. The main implementer is automatically included.
        </p>
        <ConfigurationDocsLink
          docsPath="/configuration#council-members"
          label="Council Members"
          description="Choose the models that review plans and proposals alongside the main implementer. You can select up to nine additional models. Open the detailed documentation."
        />
      </div>
      <div className="space-y-2">
        <MainImplementerCouncilRow mainImplementer={formData.mainImplementer} mainVariant={mainVariant} />
        {councilSlots.map((slot, index) => (
          <CouncilMemberRow key={index} {...props} slot={slot} index={index} />
        ))}
        {councilSlots.length < 9 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCouncilSlots(previous => [...previous, ''])}
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
  )
}

export const ProfileModelsSection = (props: ProfileModelsSectionProps) => (
  <>
    <ModelsHeader {...props} />
    <MainImplementerSection {...props} />
    <CouncilMembersSection {...props} />
  </>
)
