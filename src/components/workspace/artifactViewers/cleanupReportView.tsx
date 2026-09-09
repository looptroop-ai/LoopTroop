import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WithRawTab } from './WithRawTab'
import { parseCleanupReport } from '../phaseArtifactTypes'
import type { CleanupReportData } from '../phaseArtifactTypes'
import { RawContentWithCopy } from '../RawTextDisplay'
import { ArtifactListSection, MetadataCard } from './MetadataCard'

export function CleanupReportView({ content }: { content: string }) {
  const parsed: CleanupReportData | null = parseCleanupReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const removedPathCount = parsed.removedDirs.length + parsed.removedFiles.length
  const cleanupSucceeded = parsed.status === 'clean'

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Cleanup Report</div>}
    >
      <div className="space-y-4">
        <div className={cn(
          'rounded-md border px-3 py-3',
          cleanupSucceeded
            ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
            : 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100',
        )}>
          <div className="flex items-start gap-2">
            {cleanupSucceeded
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {cleanupSucceeded ? 'Cleanup completed cleanly' : 'Cleanup completed with warnings'}
              </div>
              <div className="mt-1 text-xs leading-5">
                Removed {removedPathCount} runtime path{removedPathCount === 1 ? '' : 's'} and preserved {parsed.preservedPaths.length} audit artifact{parsed.preservedPaths.length === 1 ? '' : 's'}.
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <MetadataCard label="Removed Dirs" value={parsed.removedDirs.length.toLocaleString()} tone={parsed.removedDirs.length > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Removed Files" value={parsed.removedFiles.length.toLocaleString()} tone={parsed.removedFiles.length > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Preserved Paths" value={parsed.preservedPaths.length.toLocaleString()} tone={parsed.preservedPaths.length > 0 ? 'info' : 'default'} />
          <MetadataCard label="Errors" value={parsed.errors.length.toLocaleString()} tone={parsed.errors.length > 0 ? 'danger' : 'success'} />
        </div>

        <div className="space-y-3">
          <ArtifactListSection
            title="Removed Directories"
            items={parsed.removedDirs}
            emptyLabel="No directories were removed."
            tone="removed"
          />
          <ArtifactListSection
            title="Removed Files"
            items={parsed.removedFiles}
            emptyLabel="No files were removed."
            tone="removed"
          />
          <ArtifactListSection
            title="Preserved Paths"
            items={parsed.preservedPaths}
            emptyLabel="No preserved paths were recorded."
            tone="preserved"
          />
          <ArtifactListSection
            title="Errors"
            items={parsed.errors}
            emptyLabel="No cleanup errors were recorded."
            tone="error"
          />
        </div>
      </div>
    </WithRawTab>
  )
}
