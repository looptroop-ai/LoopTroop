import { useState, useRef, useEffect, memo, useMemo, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LogEntry } from '@/context/LogContext'
import { formatLogLine, getEntryColor, formatTimestamp } from './logFormat'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

type StructuredSectionKind = 'input' | 'stdin' | 'output' | 'stdout' | 'error' | 'stderr'

interface StructuredBodySection {
  kind: StructuredSectionKind
  label: string
  content: string
}

const STRUCTURED_SECTION_STYLES: Record<StructuredSectionKind, { container: string; label: string }> = {
  input: {
    container: 'border-sky-500/20 bg-sky-500/10',
    label: 'text-sky-700 dark:text-sky-300',
  },
  stdin: {
    container: 'border-sky-500/20 bg-sky-500/10',
    label: 'text-sky-700 dark:text-sky-300',
  },
  output: {
    container: 'border-emerald-500/20 bg-emerald-500/10',
    label: 'text-emerald-700 dark:text-emerald-300',
  },
  stdout: {
    container: 'border-emerald-500/20 bg-emerald-500/10',
    label: 'text-emerald-700 dark:text-emerald-300',
  },
  error: {
    container: 'border-rose-500/20 bg-rose-500/10',
    label: 'text-rose-700 dark:text-rose-300',
  },
  stderr: {
    container: 'border-rose-500/20 bg-rose-500/10',
    label: 'text-rose-700 dark:text-rose-300',
  },
}

const STRUCTURED_SECTION_PATTERN = /\n(Input|Output|Error|STDIN|STDOUT|STDERR):\n/g
const LEGACY_COMMAND_SECTION_PATTERN = /(STDIN|STDOUT|STDERR): /g
const COMMAND_RESULT_SEPARATOR = '  →  '

/** For streaming entries: returns [firstLine, ...last5Lines] with a separator when truncated. */
function getStreamingVisibleLines(text: string): { lines: string[]; truncated: boolean } {
  const allLines = text.split('\n')
  if (allLines.length <= 6) return { lines: allLines, truncated: false }
  return {
    lines: [allLines[0]!, ...allLines.slice(-5)],
    truncated: true,
  }
}

function renderLogLine(entry: LogEntry, showModelName: boolean) {
  const formatted = formatLogLine(entry, showModelName)
  if (!formatted.tagText) return <>{formatted.visibleText}</>

  const color = getEntryColor(entry)
  const isToolEntry = entry.kind === 'tool' || formatted.tagText.startsWith('[TOOL')
  const isCommandEntry = formatted.tagText === '[CMD]'
  if (isToolEntry) {
    return renderToolLogLine(entry, formatted.tagText, formatted.bodyText)
  }
  if (isCommandEntry) {
    return renderCommandLogLine(entry, formatted.tagText, formatted.bodyText)
  }
  if (entry.kind === 'error' && entry.line.includes('Provider recovery required')) {
    return (
      <>
        <span className={cn('font-semibold', color)}>
          {formatted.tagText}
        </span>
        {renderSafeHttpLinks(formatted.bodyText)}
      </>
    )
  }

  return (
    <>
      <span className={cn('font-semibold', color)}>
        {formatted.tagText}
      </span>
      {formatted.bodyText}
    </>
  )
}

function renderSafeHttpLinks(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, index) => {
    if (!part.startsWith('http://') && !part.startsWith('https://')) return part
    const match = part.match(/^(.*?)([),.;!?]*)$/)
    const candidate = match?.[1] ?? part
    const trailing = match?.[2] ?? ''
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return part
      return (
        <span key={`${candidate}-${index}`}>
          <a
            href={url.toString()}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {candidate}
          </a>
          {trailing}
        </span>
      )
    } catch {
      return part
    }
  })
}

function toStructuredSectionKind(label: string): StructuredSectionKind {
  return label.toLowerCase() as StructuredSectionKind
}

function splitStructuredBody(bodyText: string): { introText: string; sections: StructuredBodySection[] } {
  const matches = Array.from(bodyText.matchAll(STRUCTURED_SECTION_PATTERN))
  if (matches.length === 0) return { introText: bodyText, sections: [] }

  const firstSectionStart = matches[0]?.index ?? bodyText.length
  const sections = matches.map((match, index): StructuredBodySection => {
    const rawLabel = match[1] ?? 'Output'
    const contentStart = (match.index ?? 0) + match[0].length
    const nextSectionStart = matches[index + 1]?.index ?? bodyText.length
    return {
      kind: toStructuredSectionKind(rawLabel),
      label: rawLabel,
      content: bodyText.slice(contentStart, nextSectionStart),
    }
  }).filter(section => section.content.trim().length > 0)

  return {
    introText: bodyText.slice(0, firstSectionStart),
    sections,
  }
}

function splitLegacyCommandBody(bodyText: string): { introText: string; sections: StructuredBodySection[] } {
  const separatorIndex = bodyText.indexOf(COMMAND_RESULT_SEPARATOR)
  if (separatorIndex === -1) return { introText: bodyText, sections: [] }

  const introText = bodyText.slice(0, separatorIndex)
  const resultText = bodyText.slice(separatorIndex + COMMAND_RESULT_SEPARATOR.length).trim()
  if (!resultText) return { introText: bodyText, sections: [] }

  const streamMatches = Array.from(resultText.matchAll(LEGACY_COMMAND_SECTION_PATTERN))
  if (streamMatches.length > 0) {
    return {
      introText,
      sections: streamMatches
        .map((match, index): StructuredBodySection => {
          const rawLabel = match[1] ?? 'STDOUT'
          const contentStart = (match.index ?? 0) + match[0].length
          const nextSectionStart = streamMatches[index + 1]?.index ?? resultText.length
          const content = resultText
            .slice(contentStart, nextSectionStart)
            .replace(/\s+\|\s*$/, '')
            .trim()

          return {
            kind: toStructuredSectionKind(rawLabel),
            label: rawLabel,
            content,
          }
        })
        .filter(section => section.content.length > 0),
    }
  }

  if (resultText.toLowerCase().startsWith('error: ')) {
    return {
      introText,
      sections: [
        {
          kind: 'error',
          label: 'ERROR',
          content: resultText.slice('error: '.length).trim(),
        },
      ],
    }
  }

  return {
    introText,
    sections: [
      {
        kind: 'stdout',
        label: 'STDOUT',
        content: resultText,
      },
    ],
  }
}

function renderStructuredLogLine(
  entry: LogEntry,
  tagText: string,
  body: { introText: string; sections: StructuredBodySection[] },
) {
  const color = getEntryColor(entry)
  const { introText, sections } = body

  return (
    <>
      <span className={cn('font-semibold', color)}>
        {tagText}
      </span>
      {introText}
      {sections.map((section) => (
        <span
          key={`${section.label}-${section.content}`}
          className={cn(
            'mt-2 block rounded-md border px-3 py-2 shadow-sm',
            STRUCTURED_SECTION_STYLES[section.kind].container,
          )}
        >
          <span
            className={cn(
              'mb-1 block text-[10px] font-semibold uppercase tracking-[0.22em]',
              STRUCTURED_SECTION_STYLES[section.kind].label,
            )}
          >
            {section.label}:
          </span>
          <span className="block whitespace-pre-wrap break-words text-foreground/90 [overflow-wrap:anywhere]">
            {section.content}
          </span>
        </span>
      ))}
    </>
  )
}

function renderToolLogLine(entry: LogEntry, tagText: string, bodyText: string) {
  const body = splitStructuredBody(bodyText)
  if (body.sections.length === 0) {
    const color = getEntryColor(entry)
    return (
      <>
        <span className={cn('font-semibold', color)}>
          {tagText}
        </span>
        {bodyText}
      </>
    )
  }

  return renderStructuredLogLine(entry, tagText, body)
}

function renderCommandLogLine(entry: LogEntry, tagText: string, bodyText: string) {
  const structuredBody = splitStructuredBody(bodyText)
  if (structuredBody.sections.length > 0) {
    return renderStructuredLogLine(entry, tagText, structuredBody)
  }

  const legacyBody = splitLegacyCommandBody(bodyText)
  if (legacyBody.sections.length > 0) {
    return renderStructuredLogLine(entry, tagText, legacyBody)
  }

  const color = getEntryColor(entry)
  return (
    <>
      <span className={cn('font-semibold', color)}>
        {tagText}
      </span>
      {bodyText}
    </>
  )
}

function StreamingPreview({ entry, showModelName }: { entry: LogEntry; showModelName: boolean }) {
  const { lines, truncated } = useMemo(() => getStreamingVisibleLines(entry.line), [entry.line])

  if (!truncated) {
    return <div>{renderLogLine(entry, showModelName)}</div>
  }

  // Build a synthetic entry for the first line to reuse tag/color rendering
  const firstLineEntry = { ...entry, line: lines[0]! }
  const tailText = lines.slice(1).join('\n')

  return (
    <div>
      <div>{renderLogLine(firstLineEntry, showModelName)}</div>
      <div className="text-muted-foreground/50 select-none text-xs py-0.5">{'···'}</div>
      <div>{tailText}</div>
    </div>
  )
}

export interface LogEntryRowProps {
  entry: LogEntry
  index: number
  showModelName: boolean
}

function showsStreamingUi(entry: LogEntry): boolean {
  return entry.streaming && (entry.kind === 'text' || entry.kind === 'reasoning')
}

export const LogEntryRow = memo(function LogEntryRow({ entry, index, showModelName }: LogEntryRowProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [copied, handleCopyEntry] = useCopyToClipboard()
  const contentRef = useRef<HTMLDivElement>(null)
  const isStreamingUiEntry = showsStreamingUi(entry)
  const copyEntry = useCallback(() => {
    const textToCopy = formatLogLine(entry, showModelName).copyText
    const timestampedText = entry.timestamp ? `[${entry.timestamp}] ${textToCopy}` : textToCopy
    handleCopyEntry(timestampedText)
  }, [entry, showModelName, handleCopyEntry])

  // Fast multiline check to predict if truncation is needed
  const isMultiline = useMemo(() => {
    if (isStreamingUiEntry) {
      return entry.line.split('\n').length > 6
    }
    
    let count = 0
    const trimmed = entry.line.trimEnd()
    let pos = trimmed.indexOf('\n')
    while (pos !== -1) {
      count++
      if (count >= 5) return true;
      pos = trimmed.indexOf('\n', pos + 1)
    }
    return false
  }, [entry.line, isStreamingUiEntry])

  useEffect(() => {
    const el = contentRef.current
    if (!el || isExpanded || isMultiline) return

    const observer = new ResizeObserver(() => {
      // Add a 4px tolerance to prevent false positives from sub-pixel rendering 
      // or minor line-height discrepancies when content fits perfectly in 5 lines.
      setIsOverflowing(el.scrollHeight > el.clientHeight + 4)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [entry.line, isExpanded, isMultiline])

  const isTruncatable = isMultiline || isOverflowing
  const renderCopyButton = (className: string) => (
    <button
      type="button"
      aria-label="Copy log entry"
      onClick={copyEntry}
      className={cn('transition-colors cursor-pointer', className)}
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )

  return (
    <div className="py-0.5 border-b border-border/30 last:border-0 flex relative group">
      <div className="flex flex-col shrink-0 w-[105px] mr-2 pt-0.5 items-start">
        <div className="flex flex-row items-center gap-1 w-full pb-1">
          <span className="text-muted-foreground/40">{formatTimestamp(entry.timestamp)}</span>
          {!isTruncatable && renderCopyButton(
            'text-muted-foreground/40 hover:text-foreground hover:bg-muted p-0.5 rounded opacity-0 group-hover:opacity-100',
          )}
        </div>
        {isTruncatable && (
          <div
            className="sticky top-1 z-10 flex items-center gap-1"
            data-log-entry-sticky-actions
          >
            {renderCopyButton(
              'text-muted-foreground/70 hover:text-foreground hover:bg-muted bg-background/90 backdrop-blur-sm p-0.5 rounded border border-border/50 shadow-sm opacity-80 hover:opacity-100',
            )}
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-[10px] bg-background/90 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 py-0.5 rounded border border-border/50 shadow-sm transition-colors cursor-pointer opacity-80 hover:opacity-100"
            >
              {isExpanded ? 'Less' : 'More'}
            </button>
          </div>
        )}
        {isStreamingUiEntry && (
          <div className="mt-0.5">
            <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded border border-emerald-500/30 shadow-sm opacity-80 select-none cursor-default animate-pulse">
              Stream
            </span>
          </div>
        )}
      </div>
      <span className="text-muted-foreground/60 mr-2 select-none shrink-0 pt-0.5">{String(index + 1).padStart(3, ' ')}</span>
      <div className="flex-1 min-w-0 pr-2">
        <div className="relative">
          <div
            ref={contentRef}
            className={cn(
              getEntryColor(entry),
              'whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere] max-w-full',
              !isExpanded && !isStreamingUiEntry && 'line-clamp-5',
            )}
          >
            {!isExpanded && isStreamingUiEntry ? (
              <StreamingPreview entry={entry} showModelName={showModelName} />
            ) : (
              <div>
                {renderLogLine(entry, showModelName)}
              </div>
            )}
          </div>
          {isTruncatable && !isExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-muted to-transparent pointer-events-none" />
          )}
        </div>
      </div>
    </div>
  )
})
