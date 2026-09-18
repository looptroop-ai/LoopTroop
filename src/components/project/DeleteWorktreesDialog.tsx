import { useEffect, useState } from 'react'
import { AlertTriangle, HardDrive, Loader2, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDeleteProjectWorktrees, useProjectWorktreesSize } from '@/hooks/useProjects'
import { useToast } from '@/components/shared/useToast'
import { BYTES_PER_KIB } from '@/lib/constants'

interface DeleteWorktreesDialogProps {
  open: boolean
  onClose: () => void
  projectId: number
  projectName: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(BYTES_PER_KIB)), units.length - 1)
  return `${(bytes / Math.pow(BYTES_PER_KIB, i)).toFixed(2)} ${units[i]}`
}

export function DeleteWorktreesDialog({ open, onClose, projectId, projectName }: DeleteWorktreesDialogProps) {
  const { addToast } = useToast()
  const sizeQuery = useProjectWorktreesSize(projectId)
  const deleteWorktrees = useDeleteProjectWorktrees()
  const [hasCalculated, setHasCalculated] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<{
    freedBytes: number
    skipped: Array<{ externalId: string; reason: string }>
  } | null>(null)

  // Reset state whenever the dialog opens fresh
  useEffect(() => {
    if (open) {
      setHasCalculated(false)
      setCleanupResult(null)
    }
  }, [open])

  const handleCalculate = async () => {
    await sizeQuery.refetch()
    setHasCalculated(true)
  }

  const handleDelete = () => {
    deleteWorktrees.mutate(projectId, {
      onSuccess: (data) => {
        setCleanupResult(data)
        setHasCalculated(false)
        if (data.skipped.length > 0) return
        addToast('success', `Worktrees deleted. Freed ${formatBytes(data.freedBytes)}.`)
        onClose()
      },
      onError: (err) => {
        const message = (err as Error)?.message || 'Failed to delete worktrees'
        addToast('error', message, 5000)
      },
    })
  }

  const isBusy = sizeQuery.isFetching || deleteWorktrees.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isBusy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Free Disk Space
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-2">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  Delete worktrees for completed &amp; canceled tickets in <span className="font-bold">{projectName}</span>
                </p>
                <p className="text-xs text-amber-800/90 dark:text-amber-200/80">
                  Removes eligible temporary working directories, including their code checkouts and
                  execution logs. Worktrees with ignored files outside LoopTroop runtime folders are
                  kept, including those with .env files, dependencies, or build output. Only tickets in
                  the <strong>Completed</strong> or <strong>Canceled</strong> column are affected.
                </p>
                <p className="text-xs text-amber-800/90 dark:text-amber-200/80">
                  Worktrees with ignored files outside LoopTroop's runtime folders are kept,
                  including .env files, dependencies, and build output. Move or remove those
                  files yourself before retrying. Explicit ticket or project deletion is
                  still destructive.
                </p>
                <p className="text-xs text-amber-800/90 dark:text-amber-200/80">
                  Your project's source code and all other files in the repository are
                  <strong> not touched</strong>. Active and queued tickets continue to work normally.
                  Tickets remain visible in the dashboard with their descriptions and status, but
                  logs and file artifacts in removed worktrees will no longer be viewable.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCalculate}
              disabled={isBusy}
            >
              {sizeQuery.isFetching ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <HardDrive className="h-4 w-4 mr-1" />
              )}
              {hasCalculated ? 'Recalculate' : 'Calculate Size'}
            </Button>
            {hasCalculated && !sizeQuery.isFetching && sizeQuery.data !== undefined && (
              <span className="text-sm font-medium">
                Total worktree size:{' '}
                <span className="font-bold text-destructive">{formatBytes(sizeQuery.data.bytes)}</span>
              </span>
            )}
          </div>

          {cleanupResult && cleanupResult.skipped.length > 0 && (
            <div role="status" className="space-y-2 text-sm">
              <p>Freed {formatBytes(cleanupResult.freedBytes)}. The following worktrees were kept:</p>
              <ul className="max-h-48 space-y-2 overflow-auto">
                {cleanupResult.skipped.map(({ externalId, reason }) => (
                  <li key={externalId} className="break-words">
                    <span className="font-medium">{externalId}</span>: {reason}
                  </li>
                ))}
              </ul>
              <p>Review the listed files before trying cleanup again.</p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={deleteWorktrees.isPending}>
              {cleanupResult ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={isBusy}
            >
              {deleteWorktrees.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Delete Worktrees
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
