import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, FileCode2, ChevronRight, ChevronDown } from 'lucide-react'
import { parseDiffStats, parseFileDiffs, computeLineNumbersWithWordDiff, type FileDiff } from './diffUtils'
import { renderUnifiedDiffLineText } from './diffWordHighlights'
import { getBeadDiffQueryKey } from '@/lib/beadDiffQuery'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

interface BeadDiffViewerProps {
  ticketId: string
  beadId: string
}

interface DiffResponse {
  diff: string
  captured: boolean
}

async function fetchBeadDiff(ticketId: string, beadId: string, signal?: AbortSignal): Promise<DiffResponse> {
  const response = await fetch(apiTicketPath(ticketId, 'beads', beadId, 'diff'), { signal })
  await throwIfNotOk(response, 'Failed to load bead diff')
  return response.json()
}

function lineClassName(line: string): string {
  let className = 'px-3 py-px'
  if (line.startsWith('diff --git')) {
    className += ' text-foreground font-semibold bg-muted/50'
  } else if (line.startsWith('@@')) {
    className += ' text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/20'
  } else if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-green-700 dark:text-green-400 bg-green-50/60 dark:bg-green-950/20'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-red-700 dark:text-red-400 bg-red-50/60 dark:bg-red-950/20'
  } else if (line.startsWith('---') || line.startsWith('+++')) {
    className += ' text-muted-foreground font-medium'
  } else {
    className += ' text-muted-foreground'
  }
  return className
}

function FileDiffBlock({ file }: { file: FileDiff }) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-mono text-left hover:bg-muted/40 transition-colors"
      >
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate font-medium text-foreground">{file.filename}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {file.additions > 0 && <span className="text-green-600 dark:text-green-400">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>}
        </span>
      </button>
      {isExpanded && (() => {
        const numbered = computeLineNumbersWithWordDiff(file.lines)
        return (
          <div className="text-xs font-mono leading-relaxed overflow-auto">
            {numbered.map((info, i) => (
              <span key={i} className={`${lineClassName(info.text)} grid grid-cols-[3.5ch_3.5ch_minmax(0,1fr)] items-start gap-x-1`}>
                <span className="text-right text-muted-foreground/50 select-none">{info.oldNum ?? ' '}</span>
                <span className="text-right text-muted-foreground/50 select-none">{info.newNum ?? ' '}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere]">
                  {renderUnifiedDiffLineText(info.text, info.wordDiffSegments)}
                </span>
              </span>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

function DiffContent({ diff }: { diff: string }) {
  const fileDiffs = parseFileDiffs(diff)

  return (
    <div>
      {fileDiffs.map((file, i) => (
        <FileDiffBlock key={i} file={file} />
      ))}
    </div>
  )
}

export function BeadDiffViewer({ ticketId, beadId }: BeadDiffViewerProps) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: getBeadDiffQueryKey(ticketId, beadId),
    queryFn: ({ signal }) => fetchBeadDiff(ticketId, beadId, signal),
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading diff…
      </div>
    )
  }

  if (isError) {
    return (
      <QueryErrorNotice
        className="p-4"
        title="Could not load the diff for this bead."
        error={error}
        onRetry={() => void refetch()}
      />
    )
  }

  if (!data?.captured) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <FileCode2 className="h-4 w-4" />
        Diff not yet captured for this bead.
      </div>
    )
  }

  if (!data.diff.trim()) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <FileCode2 className="h-4 w-4" />
        No code changes in this bead.
      </div>
    )
  }

  const stats = parseDiffStats(data.diff)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border text-xs text-muted-foreground shrink-0">
        <span>{stats.files} file{stats.files !== 1 ? 's' : ''}</span>
        <span className="text-green-600 dark:text-green-400">+{stats.additions}</span>
        <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <DiffContent diff={data.diff} />
      </div>
    </div>
  )
}
