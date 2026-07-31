import { useEffect, useState } from 'react'
import { AlertTriangle, Eye, RotateCcw, Save, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { YamlEditor } from '@/components/editor/YamlEditor'
import {
  usePrompt,
  usePromptPreview,
  useRevertPrompt,
  useSavePrompt,
} from '@/hooks/usePrompts'

interface PromptEditorProps {
  promptId: string
}

type ViewMode = 'edit' | 'default' | 'preview'

export function PromptEditor({ promptId }: PromptEditorProps) {
  const { data: prompt, isLoading, error } = usePrompt(promptId)
  const savePrompt = useSavePrompt()
  const revertPrompt = useRevertPrompt()
  const preview = usePromptPreview()

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ViewMode>('edit')
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Reset local editing state whenever a different prompt is selected or the
  // server copy changes (e.g. after a revert).
  useEffect(() => {
    if (!prompt) return
    setDraft(prompt.current)
    setMode('edit')
    setErrors([])
    setWarnings([])
    setSavedAt(null)
    preview.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id, prompt?.current])

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading prompt…</div>
  }
  if (error || !prompt) {
    return (
      <div className="p-6 text-sm text-destructive">
        {error instanceof Error ? error.message : 'Failed to load this prompt.'}
      </div>
    )
  }

  const isDirty = draft !== prompt.current

  const handleSave = async () => {
    const result = await savePrompt.mutateAsync({ id: promptId, source: draft })
    setErrors(result.errors)
    setWarnings(result.warnings)
    if (result.errors.length === 0) setSavedAt(Date.now())
  }

  const handleRevert = async () => {
    await revertPrompt.mutateAsync(promptId)
    setErrors([])
    setWarnings([])
    setSavedAt(null)
  }

  const handlePreview = async () => {
    if (mode === 'preview') {
      setMode('edit')
      return
    }
    setMode('preview')
    await preview.mutateAsync({ id: promptId, source: draft }).catch(() => undefined)
  }

  const displayedValue = mode === 'default'
    ? prompt.default
    : mode === 'preview'
      ? (preview.data?.preview ?? (preview.isPending ? 'Building preview…' : ''))
      : draft

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{prompt.id}</h3>
            {prompt.modified && <Badge variant="secondary">Modified</Badge>}
            {prompt.kind === 'global_rule' && <Badge variant="outline">Global rule</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{prompt.description}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={mode === 'default' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode(mode === 'default' ? 'edit' : 'default')}
          >
            Show default
          </Button>
          {prompt.kind === 'template' && (
            <Button variant={mode === 'preview' ? 'secondary' : 'ghost'} size="sm" onClick={() => void handlePreview()}>
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              Preview
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleRevert()}
            disabled={!prompt.modified || revertPrompt.isPending}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Revert
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || savePrompt.isPending || mode !== 'edit'}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="flex gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <ul className="space-y-0.5">
            {errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="flex gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <ul className="space-y-0.5">
            {warnings.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </div>
      )}
      {savedAt !== null && errors.length === 0 && (
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          Saved. New runs will use this prompt.
        </div>
      )}
      {mode !== 'edit' && (
        <div className="border-b border-border/60 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          {mode === 'default' ? 'Read-only: built-in default.' : 'Read-only: assembled prompt as the model receives it.'}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'preview'
          ? <pre className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-xs">{displayedValue}</pre>
          : (
            <YamlEditor
              key={`${promptId}:${mode}`}
              value={displayedValue}
              onChange={setDraft}
              readOnly={mode === 'default'}
              className="h-full"
            />
          )}
      </div>
    </div>
  )
}
