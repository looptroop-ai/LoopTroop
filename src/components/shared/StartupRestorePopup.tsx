import { useState } from 'react'
import { Database, FolderOpen, Settings } from 'lucide-react'
import { useToast } from '@/components/shared/useToast'
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

  if (profileRestored && restoredProjectCount > 0) {
    return `Restored your saved LoopTroop profile and ${restoredProjectCount} ${restoredProjectCount === 1 ? 'project' : 'projects'}.`
  }

  if (profileRestored) {
    return 'Restored your saved LoopTroop profile.'
  }

  return `Restored ${restoredProjectCount} ${restoredProjectCount === 1 ? 'project' : 'projects'} from existing local LoopTroop data.`
}

function formatRestoreBody(startupStatus: StartupStatus['storage']) {
  const { profileRestored, restoredProjectCount } = startupStatus

  if (profileRestored && restoredProjectCount > 0) {
    return 'This browser session found existing local app data and reopened your saved configuration and project state.'
  }

  if (profileRestored) {
    return 'This browser session found existing local app data and restored your saved configuration.'
  }

  return 'This browser session found existing local app data and restored your saved project state.'
}

export function StartupRestorePopup({ open, startupStatus }: StartupRestorePopupProps) {
  const { addToast } = useToast()
  const dismissRestoreNotice = useDismissStartupRestoreNotice()
  const depKey = `${open}-${startupStatus.storage.kind}-${startupStatus.storage.profileRestored}-${startupStatus.storage.restoredProjectCount}-${startupStatus.ui.restoreNotice.dismissedAt}`
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const dismissedLocally = dismissedVersion === depKey

  if (!open || dismissedLocally) return null

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-restore-title"
        className="w-full max-w-lg rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground text-background">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Existing Local Data Found
              </p>
              <h2 id="startup-restore-title" className="text-lg font-semibold text-foreground">
                {formatRestoreHeadline(startupStatus.storage)}
              </h2>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5 text-sm text-muted-foreground">
          <p>{formatRestoreBody(startupStatus.storage)}</p>

          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <Settings className="mt-0.5 h-4 w-4 text-foreground" />
              <div>
                <p className="font-medium text-foreground">
                  Profile restored: {startupStatus.storage.profileRestored ? 'Yes' : 'No'}
                </p>
                <p>Projects restored: {startupStatus.storage.restoredProjectCount}</p>
              </div>
            </div>
            <div className="mt-3 flex items-start gap-3">
              <FolderOpen className="mt-0.5 h-4 w-4 text-foreground" />
              <div>
                <p className="font-medium text-foreground">Storage path</p>
                <p className="break-all font-mono text-xs">{startupStatus.storage.dbPath}</p>
              </div>
            </div>

            {startupStatus.storage.restoredProjects.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Restored Projects
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

          <p className="text-xs">
            This notice is stored with your local LoopTroop app data and will not appear again after dismissal.
          </p>
        </div>

        <div className="flex justify-end border-t border-border px-6 py-4">
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
