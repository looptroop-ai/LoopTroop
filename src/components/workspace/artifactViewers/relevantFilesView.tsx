import { hasStringFields, isArrayOf, isNullableNumber, isOptionalNumber, isOptionalString, isOptionalStructuredOutput } from '@/lib/artifactFieldShape'
import { isRecord } from '@shared/typeGuards'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelBadge } from '@/components/shared/ModelBadge'
import { useMemo, useState } from 'react'
import { tryParseStructuredContent } from '../phaseArtifactTypes'
import type { RelevantFileScanEntry, RelevantFilesScanData } from '../phaseArtifactTypes'
import { buildReadableRawDisplayContent } from '../rawDisplayContent'
import { CopyButton, RawContentWithCopy, RawDisplayPre, RawDisplayStats } from '../RawTextDisplay'
import { CollapsibleSection } from './CollapsibleSection'
import { ArtifactProcessingNotice } from './ArtifactProcessingNotice'
import { RawAttemptVariantSelector } from './WithRawTab'
import { useActiveRawVariant } from './rawContentSources'
import { buildRawAttemptSource, getRawAttemptsFromContent } from './rawAttempts'

export function RelevantFilesScanView({ content }: { content: string }) {
  const [activeTab, setActiveTab] = useState<'files' | 'raw'>('files')
  const rawDisplayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])
  // Validated before anything reads it, not after: `modelId` reaches
  // `getModelDisplayName` inside the memo below, which calls `.startsWith` on
  // it, so a late guard never runs. `raw` is null unless the whole payload is
  // renderable, and the memos then see nothing rather than something malformed.
  //
  // The fields checked here are the ones this view renders: each file row's
  // strings, the file count and model id it prints, and the structured-output
  // record it hands to the processing notice.
  const raw = useMemo(() => {
    const parsed = tryParseStructuredContent(content) as (RelevantFilesScanData & {
      files: Array<RelevantFileScanEntry & { content_preview?: string }>
    }) | null
    const isFileEntry = (entry: unknown) => hasStringFields(entry, [
      'path', 'rationale', 'relevance', 'likely_action', 'likelyAction', 'contentPreview', 'content_preview',
    // `contentLength` is rendered through `.toLocaleString()`. Not a crash —
    // an object answers that call with "[object Object]" — so this is here for
    // consistency with the fields beside it, and has no test of its own:
    // the row lives inside a per-file expansion, and no assertion I could write
    // told the two branches apart.
    ]) && isRecord(entry) && isNullableNumber(entry.contentLength)
    if (
      !parsed
      || !isArrayOf(parsed.files, isFileEntry)
      || !isOptionalNumber((parsed as { fileCount?: unknown }).fileCount)
      || !isOptionalString(parsed.modelId)
      || !isOptionalStructuredOutput((parsed as { structuredOutput?: unknown }).structuredOutput)
    ) {
      return null
    }
    return parsed
  }, [content])
  const rawAttempts = useMemo(() => getRawAttemptsFromContent(content), [content])
  const rawAttemptSource = useMemo(
    () => buildRawAttemptSource(
      'relevant-files-scan',
      'relevant files scan',
      rawAttempts,
      raw?.modelId,
    ),
    [raw?.modelId, rawAttempts],
  )
  const rawVariantOptions = useMemo(() => rawAttemptSource?.variants ?? [], [rawAttemptSource])
  const { activeRawVariant, setActiveRawVariantId } = useActiveRawVariant(rawVariantOptions, 'relevant-files-scan:accepted-latest')
  const activeRawContent = activeRawVariant?.content ?? content
  const activeRawDisplayContent = activeRawVariant?.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  if (!raw) {
    return <RawContentWithCopy content={content} />
  }

  // Normalize: accept both camelCase (new) and snake_case (legacy DB rows)
  const parsed: RelevantFilesScanData = {
    ...raw,
    files: raw.files.map(f => ({
      ...f,
      contentPreview: f.contentPreview ?? (f as { content_preview?: string }).content_preview ?? '',
      contentLength: f.contentLength ?? (f.contentPreview ?? (f as { content_preview?: string }).content_preview ?? '').length,
    })),
    rawAttempts,
  }
  const hasRawTab = rawVariantOptions.length > 0
  const currentTab = activeTab === 'raw' && hasRawTab ? 'raw' : 'files'
  const rawVariantSelector = rawAttemptSource && rawVariantOptions.length > 0
    ? (
      <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden">
        <RawAttemptVariantSelector
          source={rawAttemptSource}
          activeVariantId={activeRawVariant?.id}
          onSelect={setActiveRawVariantId}
          ariaLabel="Relevant files raw attempts"
        />
      </div>
      )
    : null

  const relevanceColor = (r: string) =>
    r === 'high' ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
    : r === 'medium' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
    : 'text-muted-foreground bg-muted border-border'

  return (
    <div className="space-y-3">
      {currentTab === 'files' ? <ArtifactProcessingNotice structuredOutput={parsed.structuredOutput} kind="relevant-files" /> : null}
      <div className="flex items-center gap-2">
        {parsed.modelId && (
          <ModelBadge modelId={parsed.modelId} active className="px-3 py-2 h-auto flex-1 justify-start">
            <div className="text-left">
              <div className="text-xs font-medium">{getModelDisplayName(parsed.modelId)}</div>
              <div className="text-[10px] opacity-80 mt-0.5">Relevant files scan</div>
            </div>
          </ModelBadge>
        )}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${parsed.modelId ? 'ml-auto' : ''}`}>
          <button
            onClick={() => setActiveTab('files')}
            className={currentTab === 'files'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Files
          </button>
          {hasRawTab && (
            <button
              onClick={() => setActiveTab('raw')}
              className={currentTab === 'raw'
                ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
            >
              Raw
            </button>
          )}
          {currentTab === 'raw' && <CopyButton content={activeRawContent} />}
        </div>
      </div>

      {currentTab === 'raw' ? (
        <>
          {rawVariantSelector}
          <RawDisplayStats content={activeRawDisplayContent} />
          <RawDisplayPre content={activeRawDisplayContent} />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="text-xs text-muted-foreground font-medium">{parsed.fileCount} files identified</div>
            <RawDisplayStats content={rawDisplayContent} />
          </div>
          {parsed.files.map((file) => (
            <CollapsibleSection
              key={file.path}
              title={
                <span className="flex items-center gap-2 flex-wrap min-w-0 w-full">
                  <span className="font-mono text-[11px] truncate flex-1 min-w-0">{file.path}</span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border leading-none ${relevanceColor(file.relevance)}`}>
                      Relevance: {file.relevance}
                    </span>
                    <span className="text-[9px] uppercase font-bold text-muted-foreground px-1.5 py-0.5 rounded border border-border bg-muted/30 leading-none">
                      Action: {file.likely_action}
                    </span>
                  </div>
                </span>
              }
              defaultOpen={false}
            >
              <div className="space-y-2">
                <div className="text-xs italic text-muted-foreground">{file.rationale}</div>
                {file.contentPreview && (
                  <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                    {file.contentPreview}{(file.contentLength ?? 0) > 200 ? '\n…' : ''}
                  </pre>
                )}
                {file.contentLength != null && (
                  <div className="text-[10px] text-muted-foreground">{file.contentLength.toLocaleString()} chars extracted</div>
                )}
              </div>
            </CollapsibleSection>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * The envelope the plan arrives in, built from the tag rather than written out.
 *
 * This is the only place in the client that reads the model's wire protocol, and
 * it had the tag as a literal. A literal is invisible to a rename: every server
 * parser would follow the constant to the new name and this viewer would go on
 * matching the old envelope, so the approval pane would show the user a raw
 * `<TAG>` wrapper instead of the plan inside it — no error, just the wrong text.
 * Interpolating is safe: the tag names are a closed set of `[A-Z_]` words with
 * nothing a regex reads as syntax.
 */
