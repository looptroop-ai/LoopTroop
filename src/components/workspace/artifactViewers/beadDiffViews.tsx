import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CollapsibleSection } from './CollapsibleSection'
import {
  buildCombinedDiffFromBeads,
  groupFileDiffsByPath,
  parseBeadCommitsDiffContent,
  parseDiffStats,
  parseFileDiffs,
  sortBeadCommitsByPriority,
  computeLineNumbersWithWordDiff,
  type FileDiff,
  type FileDiffGroup,
} from '../diffUtils'
import { renderUnifiedDiffLineText } from '../diffWordHighlights'

function DiffFileSection({ file }: { file: FileDiff }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="border border-border/60 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/40 transition-colors"
      >
        {isOpen
          ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-mono font-medium text-foreground truncate flex-1">{file.filename}</span>
        <span className="text-[11px] font-mono text-green-600 dark:text-green-400 shrink-0">+{file.additions}</span>
        <span className="text-[11px] font-mono text-red-600 dark:text-red-400 shrink-0">-{file.deletions}</span>
      </button>
      {isOpen && (() => {
        const numbered = computeLineNumbersWithWordDiff(file.lines)
        return (
          <div className="border-t border-border/40 bg-[var(--color-card)] overflow-auto">
            <div className="text-xs font-mono leading-[1.6]">
              {numbered.map((info, i) => {
                if (info.text.startsWith('---') || info.text.startsWith('+++')) return null
                let className = 'px-4'
                if (info.text.startsWith('@@')) {
                  className += ' text-blue-600 dark:text-blue-400 bg-blue-500/5 py-0.5 font-medium border-y border-blue-500/10'
                } else if (info.text.startsWith('+')) {
                  className += ' text-green-700 dark:text-green-300 bg-green-500/10'
                } else if (info.text.startsWith('-')) {
                  className += ' text-red-700 dark:text-red-300 bg-red-500/10'
                } else {
                  className += ' text-muted-foreground/80'
                }
                return (
                  <span key={i} className={`${className} grid grid-cols-[3.5ch_3.5ch_minmax(0,1fr)] items-start gap-x-1`}>
                    <span className="text-right text-muted-foreground/50 select-none">{info.oldNum ?? ' '}</span>
                    <span className="text-right text-muted-foreground/50 select-none">{info.newNum ?? ' '}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere]">
                      {renderUnifiedDiffLineText(info.text, info.wordDiffSegments)}
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function DiffStatsRow({ label, stats }: { label: string; stats: ReturnType<typeof parseDiffStats> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 py-1 text-xs text-muted-foreground">
      <span className="font-medium">{label}</span>
      <span>{stats.files} file{stats.files !== 1 ? 's' : ''}</span>
      <span className="text-green-600 dark:text-green-400 font-mono">+{stats.additions}</span>
      <span className="text-red-600 dark:text-red-400 font-mono">-{stats.deletions}</span>
    </div>
  )
}

export function EmptyDiffState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

export function DiffFileList({ diff }: { diff: string }) {
  const files = useMemo(() => parseFileDiffs(diff), [diff])

  if (files.length === 0) {
    return <EmptyDiffState>No changed files were found in this diff.</EmptyDiffState>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {files.map((file, index) => (
        <DiffFileSection key={`${file.filename}:${index}`} file={file} />
      ))}
    </div>
  )
}

function BeadDiffSection({ bead, index }: { bead: ReturnType<typeof parseBeadCommitsDiffContent>['beads'][number]; index: number }) {
  const stats = parseDiffStats(bead.diff)
  const label = [
    bead.priority != null ? `#${bead.priority}` : null,
    bead.beadId,
    bead.label,
  ].filter(Boolean).join(' · ')

  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="font-mono text-[11px]">{label || `bead-${index + 1}`}</span>
          <span className="text-[10px] text-muted-foreground">
            {stats.files} file{stats.files !== 1 ? 's' : ''} · +{stats.additions} -{stats.deletions}
          </span>
        </span>
      )}
      defaultOpen={index === 0}
      scrollOnOpen={false}
    >
      <DiffFileList diff={bead.diff} />
    </CollapsibleSection>
  )
}

function FileGroupSection({ group }: { group: FileDiffGroup }) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-[11px]">{group.filename}</span>
          <span className="text-[10px] text-muted-foreground">
            touched in {group.occurrences.length} bead{group.occurrences.length !== 1 ? 's' : ''} · +{group.additions} -{group.deletions}
          </span>
        </span>
      )}
      defaultOpen={false}
      scrollOnOpen={false}
    >
      <div className="space-y-2">
        {group.occurrences.map((occurrence, index) => (
          <div key={`${group.filename}:${occurrence.beadId ?? occurrence.beadIndex}:${index}`} className="space-y-1">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {occurrence.beadLabel
                ? [
                    occurrence.beadPriority != null ? `#${occurrence.beadPriority}` : null,
                    occurrence.beadId ?? `bead-${occurrence.beadIndex + 1}`,
                    occurrence.beadLabel,
                  ].filter(Boolean).join(' · ')
                : [
                    occurrence.beadPriority != null ? `#${occurrence.beadPriority}` : null,
                    occurrence.beadId ?? `bead-${occurrence.beadIndex + 1}`,
                  ].filter(Boolean).join(' · ')}
            </div>
            <DiffFileSection file={occurrence} />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  )
}

export function BeadCommitsDiffView({ content }: { content: string }) {
  const parsed = useMemo(() => parseBeadCommitsDiffContent(content), [content])
  const netDiff = parsed.netDiff ?? ''
  const hasNetDiff = netDiff.trim().length > 0
  const hasBeadDiffs = parsed.beads.length > 0
  const defaultMode = hasNetDiff ? 'net' : hasBeadDiffs ? 'bead' : 'net'
  const [viewMode, setViewMode] = useState<'net' | 'bead' | 'file'>(defaultMode)
  const netStats = parseDiffStats(netDiff)
  const orderedBeads = useMemo(() => sortBeadCommitsByPriority(parsed.beads), [parsed.beads])
  const beadDiff = useMemo(() => buildCombinedDiffFromBeads(orderedBeads), [orderedBeads])
  const beadStats = useMemo(() => parseDiffStats(beadDiff), [beadDiff])
  const fileGroups = useMemo(() => groupFileDiffsByPath(orderedBeads), [orderedBeads])

  useEffect(() => {
    setViewMode(defaultMode)
  }, [defaultMode, content])

  const tabs = [
    {
      id: 'net' as const,
      label: 'Net Diff',
      disabled: !hasNetDiff,
      tooltip: !hasNetDiff ? 'Net diff will be available after passing the integration phase.' : undefined,
    },
    { id: 'bead' as const, label: 'By Bead', disabled: !hasBeadDiffs },
    { id: 'file' as const, label: 'By File', disabled: !hasBeadDiffs },
  ]
  const effectiveMode = tabs.some((tab) => tab.id === viewMode && !tab.disabled) ? viewMode : defaultMode

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              disabled={tab.disabled}
              title={tab.tooltip}
              onClick={() => setViewMode(tab.id)}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                effectiveMode === tab.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
                tab.disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {effectiveMode === 'net' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Final PR net diff" stats={netStats} />
          {hasNetDiff ? <DiffFileList diff={netDiff} /> : <EmptyDiffState>No final net diff was captured.</EmptyDiffState>}
        </div>
      ) : null}

      {effectiveMode === 'bead' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Per-bead git commits" stats={beadStats} />
          {orderedBeads.map((bead, index) => (
            <BeadDiffSection key={`${bead.beadId}:${index}`} bead={bead} index={index} />
          ))}
        </div>
      ) : null}

      {effectiveMode === 'file' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Per-file git commits" stats={beadStats} />
          {fileGroups.length > 0
            ? fileGroups.map((group) => <FileGroupSection key={group.filename} group={group} />)
            : <EmptyDiffState>No bead file touches were captured.</EmptyDiffState>}
        </div>
      ) : null}
    </div>
  )
}
