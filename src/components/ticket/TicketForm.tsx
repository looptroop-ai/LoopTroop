import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCreateTicket, useTicketAction, type Ticket } from '@/hooks/useTickets'
import { useProjects } from '@/hooks/useProjects'
import { useUI } from '@/context/useUI'
import { DropdownPicker } from '@/components/shared/DropdownPicker'
import { LoadingText } from '@/components/ui/LoadingText'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TicketDescriptionViewer } from './TicketDescriptionViewer'
import { TicketDescriptionTabs, type TicketDescriptionMode } from './TicketDescriptionTabs'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { resolveManualQaSettingLabel, type ManualQaOverride } from '@/lib/manualQaSetting'
import { useProfile } from '@/hooks/useProfile'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { GitHookPolicySetting } from '@/components/git-hooks/GitHookPolicySetting'
import { resolveGitHookPolicySetting, type GitHookPolicyOverride } from '@/lib/gitHookPolicySetting'
import { useToast } from '@/components/shared/useToast'

interface TicketFormProps {
  onClose: () => void
}

export function TicketForm({ onClose }: TicketFormProps) {
  const { dispatch } = useUI()
  const { addToast } = useToast()
  const createTicket = useCreateTicket()
  const { mutateAsync: startTicket, isPending: isStartPending } = useTicketAction()
  const { data: projects = [] } = useProjects()
  const { data: profile } = useProfile()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionMode, setDescriptionMode] = useState<TicketDescriptionMode>('raw')
  const [priority, setPriority] = useState(3)
  const [projectId, setProjectId] = useState<number | ''>('')
  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [manualQaOverride, setManualQaOverride] = useState<ManualQaOverride>(null)
  const [gitHookPolicy, setGitHookPolicy] = useState<GitHookPolicyOverride>(null)

  const selectedProject = projects.find(p => p.id === projectId) ?? projects[0]
  const effectiveProjectId = selectedProject?.id ?? ''
  const effectiveManualQa = resolveManualQaSettingLabel(
    manualQaOverride,
    selectedProject?.manualQaOverride ?? null,
    profile?.manualQaEnabled ?? false,
  )
  const effectiveGitHookPolicy = resolveGitHookPolicySetting(
    gitHookPolicy,
    selectedProject?.gitHookPolicy ?? null,
    profile?.gitHookPolicy ?? 'validate_advisory',
  )
  const createInput = () => ({
    projectId: effectiveProjectId as number,
    title,
    description: description || undefined,
    priority,
    manualQaOverride: effectiveManualQa.enabled,
    gitHookPolicy,
  })

  const handleCreateAndStart = async () => {
    if (!effectiveProjectId) return
    try {
      const created: Ticket = await createTicket.mutateAsync(createInput())
      await startTicket({ id: created.id, action: 'start' })
      dispatch({ type: 'SELECT_TICKET', ticketId: created.id, externalId: created.externalId })
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start ticket'
      alert(`Unable to create and start ticket: ${message}`)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!effectiveProjectId) {
      addToast('warning', 'Attach a project before creating a ticket.')
      return
    }
    createTicket.mutate(
      createInput(),
      {
        onSuccess: onClose,
        onError: (err) => {
          const message = err instanceof Error ? err.message : 'Failed to create ticket'
          addToast('error', `Unable to create ticket: ${message}`, 5000)
        },
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ticket Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="text-sm font-medium block mb-1">
                                    Project
                                  </label>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">Project where the ticket will run</TooltipContent>
                      </Tooltip>
            <DropdownPicker
              open={isProjectPickerOpen}
              onOpenChange={setIsProjectPickerOpen}
              trigger={
                <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all shadow-2xs',
                          isProjectPickerOpen && 'ring-2 ring-brand-500/30',
                        )}
                        style={selectedProject?.color ? {
                          borderColor: `${selectedProject.color}45`,
                          backgroundColor: `${selectedProject.color}0D`,
                        } : {
                          borderColor: 'var(--color-border)',
                        }}
                      >
                        {selectedProject ? (
                          <span className="flex items-center gap-2 min-w-0 text-left overflow-hidden">
                            <span className="shrink-0 flex items-center">
                              {selectedProject.icon?.startsWith('data:')
                                ? <img src={selectedProject.icon} className="h-5 w-5 rounded block" alt="" />
                                : <span>{selectedProject.icon}</span>}
                            </span>
                            <span className="truncate">{selectedProject.name} ({selectedProject.shortname})</span>
                          </span>
                        ) : (
                          <span className="truncate text-left text-muted-foreground">Select a project...</span>
                        )}
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">Choose project</TooltipContent>
                  </Tooltip>
              }
            >
              <div className="w-[420px] max-w-[calc(100vw-48px)]">
                <div className="rounded-md border border-input overflow-hidden">
                  {projects.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No projects available</div>
                  )}
                  {projects.map((p, idx) => {
                    const isSelected = effectiveProjectId === p.id
                    return (
                      <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                                                key={p.id}
                                                type="button"
                                                className={cn(
                                                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                                                  idx !== projects.length - 1 && 'border-b border-input',
                                                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                                                )}
                                                onClick={() => {
                                                  setProjectId(p.id)
                                                  setIsProjectPickerOpen(false)
                                                }}
                                              >
                                                <span className="shrink-0 flex items-center">
                                                  {p.icon?.startsWith('data:')
                                                    ? <img src={p.icon} className="h-5 w-5 rounded block" alt="" />
                                                    : <span>{p.icon}</span>}
                                                </span>
                                                <span className="truncate flex-1">{p.name} ({p.shortname})</span>
                                                {isSelected && <Check className="h-4 w-4 text-primary" />}
                                              </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-center text-balance">{`Use project ${p.name}`}</TooltipContent>
                        </Tooltip>
                    )
                  })}
                </div>
              </div>
            </DropdownPicker>
            {projects.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No projects are attached yet. Add a project before creating a ticket.
              </p>
            )}
          </div>

          <div>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="text-sm font-medium block mb-1">
                                    Title
                                  </label>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">Short summary of the requested work</TooltipContent>
                      </Tooltip>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Brief summary of the work"
              required
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Tooltip>
                          <TooltipTrigger asChild>
                            <label className="text-sm font-medium">
                                      Description
                                    </label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-center text-balance">Detailed implementation request</TooltipContent>
                        </Tooltip>
              <TicketDescriptionTabs mode={descriptionMode} onModeChange={setDescriptionMode} />
            </div>
            {descriptionMode === 'raw' ? (
              <textarea
                aria-label="Ticket description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[140px]"
                placeholder="Describe what you want to build..."
              />
            ) : (
              <div className="min-h-[140px] max-h-[280px] overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2">
                {description
                  ? <TicketDescriptionViewer description={description} />
                  : <p className="text-sm text-muted-foreground">No description yet.</p>}
              </div>
            )}
          </div>

          <div>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="text-sm font-medium block mb-1">
                                    Priority
                                  </label>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">Ticket urgency and processing order</TooltipContent>
                      </Tooltip>
            <select
              value={priority}
              onChange={e => setPriority(Number(e.target.value))}
              className="w-48 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value={1}>1 — Very High</option>
              <option value={2}>2 — High</option>
              <option value={3}>3 — Normal</option>
              <option value={4}>4 — Low</option>
              <option value={5}>5 — Very Low</option>
            </select>
          </div>

          <div className="rounded-md border-2 border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
              onClick={() => setIsAdvancedOpen((open) => !open)}
              aria-expanded={isAdvancedOpen}
            >
              Advanced
              <ChevronDown className={cn('h-4 w-4 transition-transform', isAdvancedOpen && 'rotate-180')} />
            </button>
            {isAdvancedOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <label className="text-xs font-medium">Manual QA checkpoint</label>
                    <ConfigurationDocsLink
                      docsPath="/configuration#manual-qa"
                      label="ticket Manual QA checkpoint"
                      description="Choose whether this ticket pauses for your verification after final tests. Open the Manual QA documentation."
                    />
                  </div>
                  <ManualQaSetting
                    idPrefix="ticket-manual-qa"
                    value={manualQaOverride}
                    onChange={setManualQaOverride}
                    inheritedEnabled={effectiveManualQa.enabled}
                    compact
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <label className="text-xs font-medium">Git hook policy</label>
                    <ConfigurationDocsLink
                      docsPath="/configuration#git-hook-policy"
                      label="ticket Git hook policy"
                      description="Choose how this ticket handles repository hooks before implementation. Open the Git hook policy documentation."
                    />
                  </div>
                  <GitHookPolicySetting
                    value={gitHookPolicy}
                    onChange={setGitHookPolicy}
                    inheritedPolicy={effectiveGitHookPolicy.policy}
                    compact
                  />
                </div>
              </div>
            )}
          </div>

        </CardContent>
      </Card>

      <div className="flex justify-end gap-2.5 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] font-mono text-xs font-medium transition-all">
              Cancel
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Close without creating ticket</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              disabled={createTicket.isPending || isStartPending || !effectiveProjectId}
              onClick={handleCreateAndStart}
              className="rounded-lg border border-border/70 bg-muted/60 text-foreground hover:bg-muted/90 active:scale-[0.98] font-mono text-xs font-semibold shadow-2xs transition-all"
            >
              {createTicket.isPending || isStartPending ? <LoadingText text="Starting" /> : 'Create & Start'}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Create ticket and immediately start the workflow</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              disabled={createTicket.isPending || isStartPending || !effectiveProjectId}
              className="rounded-lg bg-foreground text-background font-mono text-xs font-semibold hover:opacity-90 active:scale-[0.98] shadow-xs transition-all"
            >
              {createTicket.isPending ? <LoadingText text="Creating" /> : 'Create Ticket'}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Create ticket in selected project</TooltipContent>
        </Tooltip>
      </div>
    </form>
  )
}
