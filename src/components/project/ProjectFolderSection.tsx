import { AlertTriangle, CheckCircle2, CircleDot, XCircle } from 'lucide-react'
import type { ExistingProjectPreview, Project } from '@/hooks/useProjects'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from '@/lib/constants'
import { cn } from '@/lib/utils'

export interface GitCheckResponse {
  isGit: boolean
  status: 'none' | 'checking' | 'valid' | 'invalid'
  message?: string
  performanceWarning?: string | null
  githubOriginWriteAccess?: 'writable' | 'read_only' | 'unknown'
  githubViewerPermission?: string | null
  githubWriteWarning?: string | null
  scope?: 'root' | 'subfolder'
  repoRoot?: string
  hasLoopTroopState?: boolean
  existingProject?: ExistingProjectPreview | null
  alreadyAttached?: boolean
  attachedProject?: {
    id: number
    name: string
    shortname: string
    folderPath: string
  } | null
}

const formatElapsedDays = (days: number) => {
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

const formatRelativeTime = (dateStr: string) => {
  const diffInSeconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (diffInSeconds < 60) return 'Just now'
  if (diffInSeconds < SECONDS_PER_HOUR) return `${Math.floor(diffInSeconds / 60)} minutes ago`
  if (diffInSeconds < SECONDS_PER_DAY) return `${Math.floor(diffInSeconds / SECONDS_PER_HOUR)} hours ago`
  return formatElapsedDays(Math.floor(diffInSeconds / SECONDS_PER_DAY))
}

const PendingFolderStatus = ({ status }: { status: GitCheckResponse['status'] }) => (
  <CircleDot className={cn('inline h-4 w-4 text-orange-500 align-text-bottom', status === 'checking' && 'animate-pulse')} />
)

const FolderValidationStatus = ({ status }: { status: GitCheckResponse['status'] }) => {
  if (status === 'valid') return <CheckCircle2 className="inline h-4 w-4 text-green-500 align-text-bottom" />
  if (status === 'invalid') return <XCircle className="inline h-4 w-4 text-red-500 align-text-bottom" />
  if (status === 'none' || status === 'checking') return <PendingFolderStatus status={status} />
  return null
}

const GitCheckMessage = ({ message, status }: { message: string; status: GitCheckResponse['status'] }) => (
  <p className={cn('text-xs', status === 'valid' ? 'text-green-600 dark:text-green-400' : status === 'invalid' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
    {message}
  </p>
)

const AttachedProjectWarning = ({ attachedProject }: Pick<GitCheckResponse, 'attachedProject'>) => (
  <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium text-destructive">Project already added</p>
        <p className="mt-1 text-xs text-destructive/90">
          This directory is already attached{attachedProject ? ` as ${attachedProject.name} (${attachedProject.shortname})` : ''}.
          Choose a different repository or open the existing project from the project list.
        </p>
      </div>
    </div>
  </div>
)

const RepositoryWarning = ({ title, message }: { title: string; message: string }) => (
  <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div>
        <p className="font-medium text-amber-900 dark:text-amber-100">{title}</p>
        <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">{message}</p>
      </div>
    </div>
  </div>
)

const FolderWarnings = ({ gitInfo }: { gitInfo: GitCheckResponse }) => (
  <>
    {gitInfo.alreadyAttached && <AttachedProjectWarning attachedProject={gitInfo.attachedProject} />}
    {gitInfo.performanceWarning && <RepositoryWarning title="WSL mounted-drive warning" message={gitInfo.performanceWarning} />}
    {gitInfo.githubWriteWarning && <RepositoryWarning title="GitHub write access not detected" message={gitInfo.githubWriteWarning} />}
  </>
)

const StateFolderHelp = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label="State folder info" className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground">?</button>
    </TooltipTrigger>
    <TooltipContent>LoopTroop keeps this project&apos;s local runtime state here.</TooltipContent>
  </Tooltip>
)

const ProjectStateFolder = ({ folder }: { folder: string }) => (
  <div>
    <div className="mb-1 flex items-center gap-1.5">
      <label className="text-sm font-medium">State Folder</label>
      <StateFolderHelp />
    </div>
    <span className="text-sm text-muted-foreground font-mono">{`${folder.replace(/[\\/]+$/, '')}/.looptroop`}</span>
  </div>
)

interface ProjectTimestampProps {
  label: string
  dateStr: string
  ticketExternalId?: string
}

const ProjectTimestampContent = ({ dateStr, ticketExternalId }: Omit<ProjectTimestampProps, 'label'>) => (
  <>
    {formatRelativeTime(dateStr)}
    {ticketExternalId && <span className="ml-1 text-muted-foreground font-normal">({ticketExternalId})</span>}
  </>
)

const ProjectTimestampTooltip = ({ dateStr, ticketExternalId }: Omit<ProjectTimestampProps, 'label'>) => (
  <Tooltip>
    <TooltipTrigger asChild><span className="text-sm font-medium cursor-help"><ProjectTimestampContent dateStr={dateStr} ticketExternalId={ticketExternalId} /></span></TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">{`${new Date(dateStr).toLocaleString()}${ticketExternalId ? ` - Ticket ${ticketExternalId}` : ''}`}</TooltipContent>
  </Tooltip>
)

const ProjectTimestamp = ({ label, dateStr, ticketExternalId }: ProjectTimestampProps) => (
  <div>
    <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1 block">{label}</label>
    <ProjectTimestampTooltip dateStr={dateStr} ticketExternalId={ticketExternalId} />
  </div>
)

const SavedProjectFolderSection = ({ project, folder }: { project: Project; folder: string }) => (
  <div className="space-y-4">
    <div>
      <label className="text-sm font-medium block mb-1">Project Folder</label>
      <span className="text-sm text-muted-foreground font-mono">{folder}</span>
    </div>
    <ProjectStateFolder folder={folder} />
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border pt-4">
      <ProjectTimestamp label="Project Created" dateStr={project.createdAt} />
      <ProjectTimestamp label="Last Update" dateStr={project.updatedAt} ticketExternalId={project.latestActivityTicketExternalId} />
    </div>
  </div>
)

interface ProjectFolderSectionProps {
  project?: Project | null
  folder: string
  onFolderChange: (value: string) => void
  onBrowse: () => void
  isPending: boolean
  restoreMode: boolean
  gitInfo: GitCheckResponse
}

const ProjectFolderInput = ({ folder, onFolderChange, onBrowse, isPending, restoreMode, gitInfo }: Omit<ProjectFolderSectionProps, 'project'>) => {
  const message = gitInfo.message ?? ''
  return (
    <div>
      <label htmlFor="project-folder" className="text-sm font-medium block mb-1">
        Project Folder <span className="text-muted-foreground font-normal">(must be git-initialized{' '}<FolderValidationStatus status={gitInfo.status} />)</span>
      </label>
      <div className="space-y-2">
        <div className="flex gap-2">
          <input id="project-folder" name="projectFolder" type="text" value={folder} onChange={e => onFolderChange(e.target.value)} disabled={isPending} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono" placeholder="Choose a folder or type a path" autoComplete="off" required />
          <Button type="button" variant="outline" onClick={onBrowse} disabled={isPending}>Browse...</Button>
        </div>
        {message && !restoreMode && <GitCheckMessage message={message} status={gitInfo.status} />}
      </div>
      <FolderWarnings gitInfo={gitInfo} />
    </div>
  )
}

export const ProjectFolderSection = ({ project, ...props }: ProjectFolderSectionProps) => {
  if (project) return <SavedProjectFolderSection project={project} folder={props.folder} />
  return <ProjectFolderInput {...props} />
}
