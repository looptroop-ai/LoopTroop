import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, PanelLeftClose, PanelLeftOpen, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { usePromptCatalog, useResetAllPrompts, type PromptGroup } from '@/hooks/usePrompts'
import { PromptEditor } from './PromptEditor'

function firstPromptId(groups: PromptGroup[]): string | null {
  for (const group of groups) {
    for (const status of group.statuses) {
      const first = status.prompts[0]
      if (first) return first.id
    }
  }
  return null
}

export function PromptsDialog() {
  const { data, isLoading, error } = usePromptCatalog()
  const resetAll = useResetAllPrompts()
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)

  const groups = useMemo(() => data?.groups ?? [], [data])

  useEffect(() => {
    if (groups.length === 0) return
    if (selectedGroupId === null) setSelectedGroupId(groups[0]?.id ?? null)
    if (selectedPromptId === null) setSelectedPromptId(firstPromptId(groups))
  }, [groups, selectedGroupId, selectedPromptId])

  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading prompts…</div>
  }
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-destructive">
        {error instanceof Error ? error.message : 'Failed to load prompts.'}
      </div>
    )
  }

  return (
    <div className="flex h-[calc(80vh-8rem)] min-h-0 flex-col">
      {data.warnings.length > 0 && (
        <div className="flex gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <ul className="space-y-0.5">
            {data.warnings.map((warning) => (
              <li key={warning.id}><span className="font-mono">{warning.id}</span>: {warning.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
        <>
        {/* Workflow groups */}
        <nav className="w-44 shrink-0 overflow-y-auto border-r border-border/60 p-2">
          {groups.map((group, index) => (
            <div key={group.id}>
              {group.id === 'general' && index > 0 && <div className="my-2 border-t border-border/60" />}
              <button
                onClick={() => setSelectedGroupId(group.id)}
                className={cn(
                  'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer',
                  activeGroup?.id === group.id
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {group.label}
              </button>
            </div>
          ))}
        </nav>

        {/* Prompts within the selected group */}
        <div className="w-64 shrink-0 overflow-y-auto border-r border-border/60 p-2">
          {activeGroup?.statuses.map((status) => (
            <div key={status.status} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {status.label}
              </div>
              {status.prompts.map((prompt) => (
                <button
                  key={prompt.id}
                  onClick={() => setSelectedPromptId(prompt.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer',
                    selectedPromptId === prompt.id
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{prompt.description}</span>
                  {prompt.modified && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                </button>
              ))}
            </div>
          ))}
        </div>
        </>
        )}

        {/* Editor */}
        <div className="min-w-0 flex-1">
          {selectedPromptId
            ? (
              <PromptEditor
                promptId={selectedPromptId}
                wordWrap={wordWrap}
                onToggleWordWrap={() => setWordWrap((wrap) => !wrap)}
              />
            )
            : <div className="p-6 text-sm text-muted-foreground">Select a prompt to edit.</div>}
        </div>
      </div>

      <footer className="flex items-stretch border-t border-border/60">
        {!sidebarCollapsed ? (
          <>
            {/* Aligned with the workflow-group column (w-44) */}
            <div className="flex w-44 shrink-0 items-center px-2 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse the list columns"
              >
                <PanelLeftClose className="mr-1.5 h-3.5 w-3.5" />
                Hide list
              </Button>
            </div>
            {/* Aligned with the prompt-list column (w-64) */}
            <div className="flex w-64 shrink-0 items-center gap-2 border-l border-border/60 px-3 py-2 text-xs text-muted-foreground">
              {data.modifiedCount > 0
                ? <Badge variant="secondary">{data.modifiedCount} modified</Badge>
                : <span>All prompts are at their defaults</span>}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSidebarCollapsed(false)}
              title="Restore the list columns"
            >
              <PanelLeftOpen className="mr-1.5 h-3.5 w-3.5" />
              Show list
            </Button>
            <span className="h-3.5 w-px bg-border" aria-hidden />
            {data.modifiedCount > 0
              ? <Badge variant="secondary">{data.modifiedCount} modified</Badge>
              : <span>All prompts are at their defaults</span>}
          </div>
        )}
        {/* Aligned with the editor column */}
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 border-l border-border/60 px-4 py-2">
          <span className="hidden truncate font-mono sm:inline" title={data.templatesDir}>{data.templatesDir}</span>
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Discard all prompt edits?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={resetAll.isPending}
                onClick={async () => {
                  await resetAll.mutateAsync()
                  setConfirmReset(false)
                }}
              >
                Reset all
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={data.modifiedCount === 0}
              onClick={() => setConfirmReset(true)}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset all to defaults
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}
