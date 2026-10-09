import { AlertTriangle } from 'lucide-react'
import type { ExistingProjectPreview, ExistingStateAction } from '@/hooks/useProjects'
import { cn } from '@/lib/utils'
import { ExistingProjectActionDialog } from './ExistingProjectActionDialog'

interface ProjectRestoreSectionProps {
  project: ExistingProjectPreview
  action: ExistingStateAction
  onActionChange: (value: ExistingStateAction) => void
  isBusy: boolean
  scope?: 'root' | 'subfolder'
  repoRoot?: string
  name: string
  shortname: string
}

const ProjectRestoreHeading = ({ scope, repoRoot }: Pick<ProjectRestoreSectionProps, 'scope' | 'repoRoot'>) => (
  <div className="flex items-start gap-3">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
    <div className="min-w-0">
      <p className="font-medium text-amber-900 dark:text-amber-100">Existing LoopTroop project detected</p>
      <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">Choose which saved project data to keep when attaching this repository.</p>
      {scope === 'subfolder' && repoRoot && <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">Repository root: <span className="font-mono">{repoRoot}</span></p>}
    </div>
  </div>
)

const ProjectRestoreOptions = ({ project, action, onActionChange, isBusy }: Pick<ProjectRestoreSectionProps, 'project' | 'action' | 'onActionChange' | 'isBusy'>) => (
  <fieldset className="grid gap-2" disabled={isBusy}>
    <legend className="sr-only">Existing project action</legend>
    {([
      { value: 'restore', title: 'Restore everything', description: `Keep all ${project.ticketCount} tickets, workflow data, settings, and the current counter.` },
      { value: 'clear_tickets', title: 'Keep project settings, clear tickets', description: 'Keep project identity and overrides, but permanently remove every ticket and its content.' },
      { value: 'start_fresh', title: 'Start fresh', description: 'Delete the entire .looptroop state folder and create a new project from this form.' },
    ] as const).map(option => (
      <label key={option.value} className={cn('flex cursor-pointer gap-3 rounded-md border bg-background/70 p-3 transition-colors', action === option.value ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground/50')}>
        <input type="radio" name="existing-state-action" value={option.value} checked={action === option.value} onChange={() => onActionChange(option.value)} className="mt-0.5 h-4 w-4 accent-primary" />
        <span>
          <span className="block font-medium text-foreground">{option.title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
        </span>
      </label>
    ))}
  </fieldset>
)

const ActiveTicketsWarning = ({ project, action }: Pick<ProjectRestoreSectionProps, 'project' | 'action'>) => {
  if (action === 'restore' || (project.activeTicketCount ?? 0) <= 0) return null
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs font-medium text-destructive">
      Warning: {project.activeTicketCount}{' '}{project.activeTicketCount === 1 ? 'ticket is' : 'tickets are'} currently active and will be deleted.
    </p>
  )
}

const KeptProjectEntries = ({ project, action, name, shortname }: Pick<ProjectRestoreSectionProps, 'project' | 'action' | 'name' | 'shortname'>) => {
  if (action === 'restore') {
    return <><li>{project.ticketCount} tickets and all workflow/artifact data</li><li>Ticket counter at {project.ticketCounter}</li><li>Project identity, timestamps, and overrides</li></>
  }
  if (action === 'clear_tickets') {
    return <><li>Short name <span className="font-mono">{project.shortname}</span></li><li>Project identity, appearance, creation time, and overrides</li></>
  }
  return <><li>Name: {name}</li><li>Short name: <span className="font-mono">{shortname}</span></li><li>Appearance and settings shown above</li></>
}

const KeptProjectData = (props: Pick<ProjectRestoreSectionProps, 'project' | 'action' | 'name' | 'shortname'>) => (
  <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-300">{props.action === 'start_fresh' ? 'Created from current form' : 'Kept'}</p>
    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
      <KeptProjectEntries {...props} />
      {props.action !== 'start_fresh' && <li>Current form edits to visible project settings</li>}
    </ul>
  </div>
)

const DeletedProjectEntries = ({ action }: Pick<ProjectRestoreSectionProps, 'action'>) => {
  if (action === 'restore') return <li>No saved LoopTroop data</li>
  if (action === 'clear_tickets') {
    return <><li>All tickets, workflow data, logs, and artifacts</li><li>Managed worktrees and saved OpenCode sessions</li><li>Ticket counter resets to 0</li></>
  }
  return <><li>The entire existing <span className="font-mono">.looptroop</span> state folder</li><li>All tickets, artifacts, worktrees, and saved metadata</li></>
}

const DeletedProjectData = ({ action }: Pick<ProjectRestoreSectionProps, 'action'>) => (
  <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-destructive">{action === 'restore' ? 'Not deleted' : 'Deleted'}</p>
    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground"><DeletedProjectEntries action={action} /></ul>
  </div>
)

const ProjectRestoreContent = (props: ProjectRestoreSectionProps) => (
  <div className="space-y-4 rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
    <ProjectRestoreHeading scope={props.scope} repoRoot={props.repoRoot} />
    <ProjectRestoreOptions project={props.project} action={props.action} onActionChange={props.onActionChange} isBusy={props.isBusy} />
    <ActiveTicketsWarning project={props.project} action={props.action} />
    <div className="grid gap-3 rounded-md border border-amber-300/60 bg-background/50 p-3 sm:grid-cols-2 dark:border-amber-700/50">
      <KeptProjectData project={props.project} action={props.action} name={props.name} shortname={props.shortname} />
      <DeletedProjectData action={props.action} />
    </div>
  </div>
)

export const ProjectRestoreSection = ({ project, restoreMode, ...props }: Omit<ProjectRestoreSectionProps, 'project'> & { project: ExistingProjectPreview | null | undefined; restoreMode: boolean }) => {
  if (!restoreMode || !project) return null
  return <ProjectRestoreContent {...props} project={project} />
}

interface ProjectRestoreConfirmationProps {
  project: ExistingProjectPreview | null | undefined
  restoreMode: boolean
  action: ExistingStateAction
  open: boolean
  nextShortname: string
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}

export const ProjectRestoreConfirmation = ({ project, restoreMode, action, ...props }: ProjectRestoreConfirmationProps) => {
  if (!restoreMode || !project || action === 'restore') return null
  return <ExistingProjectActionDialog {...props} action={action} project={project} />
}
