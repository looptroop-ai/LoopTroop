import { useId, useRef, useState } from 'react'
import { Database, FolderOpen, Settings } from 'lucide-react'
import { useToast } from '@/components/shared/useToast'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import {
  useDismissStartupRestoreNotice,
  type StartupStatus,
} from '@/hooks/useStartupStatus'

interface StartupRestorePopupProps {
  open: boolean
  startupStatus: StartupStatus
}

function formatRestoreHeadline(startupStatus: StartupStatus['storage']) {
  const { profileRestored, restoredProjectCount } = startupStatus
  const projects = `${restoredProjectCount} ${restoredProjectCount === 1 ? 'project' : 'projects'}`

  if (profileRestored && restoredProjectCount > 0) {
    return `Your saved profile and ${projects} are ready.`
  }

  if (profileRestored) {
    return 'Your saved profile is ready.'
  }

  return restoredProjectCount === 1 ? 'Your saved project is ready.' : `Your ${projects} are ready.`
}

export function StartupRestorePopup({ open, startupStatus }: StartupRestorePopupProps) {
  const { addToast } = useToast()
  const dismissRestoreNotice = useDismissStartupRestoreNotice()
  const depKey = `${open}-${startupStatus.storage.kind}-${startupStatus.storage.profileRestored}-${startupStatus.storage.restoredProjectCount}-${startupStatus.ui.restoreNotice.dismissedAt}`
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const dismissedLocally = dismissedVersion === depKey
  const visible = open && !dismissedLocally
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const handleTrapKeyDown = useDialogFocus(visible, panelRef)

  if (!visible) return null

  const handleDismiss = () => {
    dismissRestoreNotice.mutate(undefined, {
      onSuccess: () => {
        setDismissedVersion(depKey)
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Failed to dismiss restore notice'
        addToast('error', message, 5000)
      },
    })
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="shrink-0 border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground text-background">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Saved data found
              </p>
              <h2 id={titleId} className="text-lg font-semibold text-foreground">
                {formatRestoreHeadline(startupStatus.storage)}
              </h2>
            </div>
          </div>
        </div>

        <div role="region" aria-labelledby={titleId} tabIndex={0} className="min-h-24 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm text-muted-foreground">
          <p>
            At startup, LoopTroop checks its local database for a saved profile or project. This notice shows what it
            found and where the data is stored.
          </p>

          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <Settings className="mt-0.5 h-4 w-4 text-foreground" />
              <div>
                <p className="font-medium text-foreground">
                  Profile found: {startupStatus.storage.profileRestored ? 'Yes' : 'No'}
                </p>
                <p>Projects found: {startupStatus.storage.restoredProjectCount}</p>
              </div>
            </div>
            <div className="mt-3 flex items-start gap-3">
              <FolderOpen className="mt-0.5 h-4 w-4 text-foreground" />
              <div>
                <p className="font-medium text-foreground">Local data location</p>
                <p className="break-all font-mono text-xs">{startupStatus.storage.dbPath}</p>
              </div>
            </div>

            {startupStatus.storage.restoredProjects.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Saved projects
                </p>
                <div className="space-y-3">
                  {startupStatus.storage.restoredProjects.map((project) => (
                    <div
                      key={project.folderPath}
                      className="rounded-lg border border-border bg-background/70 px-3 py-2"
                    >
                      <p className="font-medium text-foreground">
                        {project.name} <span className="font-mono text-xs text-muted-foreground">({project.shortname})</span>
                      </p>
                      <p className="break-all font-mono text-xs">{project.folderPath}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <p className="text-xs">After you continue, this notice stays dismissed for this local database.</p>
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={dismissRestoreNotice.isPending}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {dismissRestoreNotice.isPending ? 'Saving...' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
