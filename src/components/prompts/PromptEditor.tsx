import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Columns2, Eye, RotateCcw, Save, WrapText, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { YamlEditor } from '@/components/editor/YamlEditor'
import { YamlDiffEditor } from '@/components/editor/YamlDiffEditor'
import {
  usePrompt,
  usePromptPreview,
  useRevertPrompt,
  useSavePrompt,
} from '@/hooks/usePrompts'

interface PromptEditorProps {
  promptId: string
  wordWrap: boolean
  onToggleWordWrap: () => void
}

/**
 * `edit` shows only the user's version; `diff` shows the built-in default
 * side-by-side with a still-editable copy of the user's version; `preview`
 * shows the assembled prompt the model receives.
 */
type ViewMode = 'edit' | 'diff' | 'preview'

export function PromptEditor({ promptId, wordWrap, onToggleWordWrap }: PromptEditorProps) {
  const { data: prompt, isLoading, error } = usePrompt(promptId)
  const savePrompt = useSavePrompt()
  const revertPrompt = useRevertPrompt()
  const preview = usePromptPreview()

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ViewMode>('edit')
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const promptCurrent = prompt?.current

  // `preview.reset` is a fresh function on every render of the mutation hook. Held in
  // a ref, resetting the preview stays something the reset below *does* rather than
  // something that makes it run.
  const previewResetRef = useRef(preview.reset)
  useEffect(() => {
    previewResetRef.current = preview.reset
  })

  // What is on screen right now, readable from inside an awaited save.
  const draftRef = useRef(draft)
  const promptIdRef = useRef(promptId)
  useEffect(() => {
    draftRef.current = draft
    promptIdRef.current = promptId
  })

  /**
   * Set while the server copy this editor is about to receive is the echo of its own
   * save. A successful save invalidates the query, the copy comes back changed, and
   * that is not an external edit — without this the reset below erased the "Saved"
   * line and the warnings the save had just produced, milliseconds after showing them.
   *
   * A flag rather than a comparison against the submitted text: the server stores a
   * re-serialised document, not the bytes it was sent, so any save whose formatting
   * differs from what `js-yaml` emits comes back different and a content check would
   * call the editor's own save somebody else's edit.
   */
  const ownSaveEchoRef = useRef(false)
  /**
   * Whether that echo should replace what is on screen. It should not when the user
   * carried on typing while the save was in flight: the save still happened, so the
   * invalidation is still ours to absorb, but the canonical copy it brings back is
   * older than the draft and adopting it would delete what they typed.
   */
  const echoAdoptsDraftRef = useRef(true)
  const lastPromptIdRef = useRef<string | undefined>(undefined)

  // Reset local editing state whenever a different prompt is selected or the server
  // copy changes underneath the editor (a revert, or another writer).
  useEffect(() => {
    if (promptCurrent === undefined) return
    const isPromptSwitch = lastPromptIdRef.current !== promptId
    lastPromptIdRef.current = promptId
    const isOwnSaveEcho = !isPromptSwitch && ownSaveEchoRef.current
    ownSaveEchoRef.current = false

    if (isOwnSaveEcho) {
      // The stored copy is canonical and is what the editor should now be showing,
      // but the save's own feedback still describes it.
      if (echoAdoptsDraftRef.current) setDraft(promptCurrent)
      echoAdoptsDraftRef.current = true
      return
    }

    setDraft(promptCurrent)
    setMode('edit')
    setErrors([])
    setWarnings([])
    setSavedAt(null)
    previewResetRef.current()
  }, [promptId, promptCurrent])

  // Editing is the point at which the last save stops being news.
  const handleDraftChange = useCallback((next: string) => {
    ownSaveEchoRef.current = false
    setDraft(next)
    setErrors([])
    setWarnings([])
    setSavedAt(null)
  }, [])

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

  /**
   * The editor is one component instance for every prompt — the dialog swaps the
   * `promptId` prop rather than remounting — and it stays editable while a request is
   * in flight. So a result describes the prompt and the text it was sent for, and
   * belongs to neither if either has moved on since.
   */
  const describesCurrentEditor = (savedPromptId: string, source: string) =>
    promptIdRef.current === savedPromptId && draftRef.current === source

  const handleSave = async () => {
    const source = draft
    const savedPromptId = promptId
    let result: Awaited<ReturnType<typeof savePrompt.mutateAsync>>
    try {
      result = await savePrompt.mutateAsync({ id: savedPromptId, source })
    } catch (err) {
      // A refused request — offline, a 500, an unreadable response — used to travel
      // out of an onClick as an unhandled rejection, leaving the editor looking as
      // though nothing had been asked of it.
      if (!describesCurrentEditor(savedPromptId, source)) return
      setErrors([err instanceof Error ? err.message : 'Failed to save this prompt.'])
      setWarnings([])
      setSavedAt(null)
      return
    }

    const isCurrent = describesCurrentEditor(savedPromptId, source)
    if (result.errors.length === 0 && promptIdRef.current === savedPromptId) {
      // The write happened, so its echo is coming either way; only whether the editor
      // should adopt what comes back depends on the draft still being the saved one.
      ownSaveEchoRef.current = true
      echoAdoptsDraftRef.current = isCurrent
    }
    if (!isCurrent) return
    if (result.errors.length === 0) setSavedAt(Date.now())
    setErrors(result.errors)
    setWarnings(result.warnings)
  }

  const handleRevert = async () => {
    const revertedPromptId = promptId
    ownSaveEchoRef.current = false
    try {
      await revertPrompt.mutateAsync(revertedPromptId)
    } catch (err) {
      if (promptIdRef.current !== revertedPromptId) return
      setErrors([err instanceof Error ? err.message : 'Failed to revert this prompt.'])
      return
    }
    if (promptIdRef.current !== revertedPromptId) return
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

  const previewText = preview.data?.preview ?? (preview.isPending ? 'Building preview…' : '')

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
            variant={wordWrap ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={wordWrap}
            onClick={onToggleWordWrap}
          >
            <WrapText className="mr-1.5 h-3.5 w-3.5" />
            Word wrap
          </Button>
          <Button
            variant={mode === 'diff' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode(mode === 'diff' ? 'edit' : 'diff')}
          >
            <Columns2 className="mr-1.5 h-3.5 w-3.5" />
            Compare to default
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
            disabled={!isDirty || savePrompt.isPending || mode === 'preview'}
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
      {mode === 'diff' && (
        <div className="flex border-b border-border/60 bg-muted/40 text-xs text-muted-foreground">
          <span className="flex-1 border-r border-border/60 px-4 py-1.5">Built-in default (read-only)</span>
          <span className="flex-1 px-4 py-1.5">Your version — editable</span>
        </div>
      )}
      {mode === 'preview' && (
        <div className="border-b border-border/60 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          Read-only: assembled prompt as the model receives it.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'preview' && (
          <pre className={`h-full overflow-auto p-4 font-mono text-xs ${wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}`}>
            {previewText}
          </pre>
        )}
        {mode === 'diff' && (
          <YamlDiffEditor
            key={`${promptId}:diff`}
            original={prompt.default}
            modified={draft}
            onChange={handleDraftChange}
            wordWrap={wordWrap}
            className="h-full overflow-auto"
          />
        )}
        {mode === 'edit' && (
          <YamlEditor
            key={`${promptId}:edit`}
            value={draft}
            onChange={handleDraftChange}
            wordWrap={wordWrap}
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}
