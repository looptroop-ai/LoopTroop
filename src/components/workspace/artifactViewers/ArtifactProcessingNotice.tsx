import {
  STRUCTURED_INTERVENTION_CATEGORY_ORDER,
} from '@shared/structuredInterventions'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import {
  normalizeStructuredRetryDiagnostics,
  type StructuredRetryDiagnostic,
} from '@shared/structuredRetryDiagnostics'
import { cn } from '@/lib/utils'
import { CollapsibleSection } from './CollapsibleSection'
import type { ArtifactStructuredOutputData } from '../phaseArtifactTypes'
import {
  buildArtifactProcessingNoticeCopy,
  getStructuredOutputInterventions,
  getStructuredOutputSourceMessages,
  INTERVENTION_CATEGORY_COPY,
  INTERVENTION_STAGE_LABELS,
} from '../artifactProcessingNotice'
import type {
  ArtifactProcessingKind,
  ArtifactProcessingNoticeContext,
  ArtifactProcessingStatus,
} from '../artifactProcessingNotice'

export function CollapsibleWarningNotice({
  title,
  summary,
  body,
  detail,
  headerActions,
  defaultOpen = false,
}: {
  title: React.ReactNode
  summary?: React.ReactNode
  body?: React.ReactNode
  detail?: React.ReactNode
  headerActions?: React.ReactNode
  defaultOpen?: boolean
}) {
  if (!summary && !body && !detail) {
    return null
  }

  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-col items-start gap-0">
          <span className="text-[10px] font-medium leading-[0.85rem]">{title}</span>
          {summary ? (
            <span className="text-[9px] font-normal leading-[0.8rem] opacity-80">
              {summary}
            </span>
          ) : null}
        </span>
      )}
      defaultOpen={defaultOpen}
      scrollOnOpen={false}
      className="border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/20"
      headerActions={headerActions}
      triggerClassName="gap-0.5 px-2 py-1 text-amber-950 hover:bg-amber-100/60 dark:text-amber-100 dark:hover:bg-amber-900/20"
      contentClassName="pt-0 text-amber-950 dark:text-amber-100"
    >
      {body ? <div className="leading-5">{body}</div> : null}
      {detail ? (
        <div className={cn('text-[11px] opacity-90 leading-5', body ? 'mt-1' : undefined)}>
          {detail}
        </div>
      ) : null}
    </CollapsibleSection>
  )
}


function ArtifactInterventionBreakdown({ interventions }: { interventions: StructuredIntervention[] }) {
  const groups = STRUCTURED_INTERVENTION_CATEGORY_ORDER
    .map((category) => ({
      category,
      interventions: interventions.filter((intervention) => intervention.category === category),
    }))
    .filter((group) => group.interventions.length > 0)

  return (
    <div className="min-w-0 max-w-full space-y-3">
      {groups.map((group) => {
        const categoryCopy = INTERVENTION_CATEGORY_COPY[group.category]
        return (
          <div key={group.category} className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-semibold ${categoryCopy.className}`}>
                {categoryCopy.label}
              </span>
              <span className="opacity-80">{group.interventions.length}</span>
            </div>
            <div className="space-y-2">
              {group.interventions.map((intervention, index) => {
                const rawMessages = intervention.rawMessages ?? []
                const hasTechnicalDetailInRawMessages = Boolean(
                  intervention.technicalDetail
                  && rawMessages.some((message) => message.trim() === intervention.technicalDetail?.trim()),
                )

                return (
                  <div key={`${group.category}:${intervention.code}:${index}`} className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-semibold">{intervention.title}</div>
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {INTERVENTION_STAGE_LABELS[intervention.stage]}
                      </span>
                      {intervention.target ? (
                        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-foreground">
                          {intervention.target}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 space-y-1 text-[11px] leading-5">
                      {intervention.exactCorrection ? (
                        <div><span className="font-medium">Exact correction:</span> {intervention.exactCorrection}</div>
                      ) : null}
                      {intervention.rule ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">Rule:</span>
                          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground">
                            {intervention.rule.label}
                          </span>
                          <span className="rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {intervention.rule.id}
                          </span>
                        </div>
                      ) : null}
                      {intervention.examples && intervention.examples.length > 0 ? (
                        <div className="space-y-2 rounded border border-border bg-background/80 px-2 py-2">
                          {intervention.examples.map((example, exampleIndex) => (
                            <div key={`${group.category}:${intervention.code}:${index}:example:${exampleIndex}`} className="space-y-1">
                              {example.scope ? (
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  {example.scope}
                                </div>
                              ) : null}
                              {example.before ? (
                                <div>
                                  <span className="font-medium">Before:</span>{' '}
                                  <span className="font-mono text-[10px] text-muted-foreground">{example.before}</span>
                                </div>
                              ) : null}
                              {example.after ? (
                                <div>
                                  <span className="font-medium">After:</span>{' '}
                                  <span className="font-mono text-[10px] text-muted-foreground">{example.after}</span>
                                </div>
                              ) : null}
                              {example.note ? (
                                <div><span className="font-medium">Note:</span> {example.note}</div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div><span className="font-medium">What:</span> {intervention.summary}</div>
                      <div><span className="font-medium">Why:</span> {intervention.why}</div>
                      <div><span className="font-medium">How:</span> {intervention.how}</div>
                      {intervention.technicalDetail && !hasTechnicalDetailInRawMessages ? (
                        <div className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
                          {intervention.technicalDetail}
                        </div>
                      ) : null}
                      {rawMessages.length > 0 ? (
                        <div className="space-y-1">
                          <div className="font-medium">Raw message{rawMessages.length === 1 ? '' : 's'}:</div>
                          <div className="space-y-1">
                            {rawMessages.map((message, messageIndex) => (
                              <pre
                                key={`${group.category}:${intervention.code}:${index}:raw:${messageIndex}`}
                                className="overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap"
                              >
                                {message}
                              </pre>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ArtifactSourceMessages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
        Raw Source Messages <span className="normal-case tracking-normal opacity-70">({messages.length})</span>
      </div>
      <div className="space-y-1">
        {messages.map((message, index) => (
          <pre
            key={`${index}:${message}`}
            className="overflow-x-auto rounded border border-amber-300/60 bg-background/70 px-2 py-2 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap dark:border-amber-900/50"
          >
            {message}
          </pre>
        ))}
      </div>
    </div>
  )
}

function normalizeNoticeRawMessage(message: string): string {
  return message.trim()
}

function getUndisplayedSourceMessages(
  structuredOutput: ArtifactStructuredOutputData | undefined,
  interventions: StructuredIntervention[],
  retryDiagnostics: StructuredRetryDiagnostic[],
): string[] {
  const displayed = new Set<string>()

  for (const intervention of interventions) {
    if (intervention.technicalDetail) {
      displayed.add(normalizeNoticeRawMessage(intervention.technicalDetail))
    }
    for (const message of intervention.rawMessages ?? []) {
      displayed.add(normalizeNoticeRawMessage(message))
    }
  }

  for (const diagnostic of retryDiagnostics) {
    displayed.add(normalizeNoticeRawMessage(diagnostic.validationError))
    displayed.add(normalizeNoticeRawMessage(`Retry attempt ${diagnostic.attempt} excerpt:\n${diagnostic.excerpt.trim()}`))
  }

  return getStructuredOutputSourceMessages(structuredOutput)
    .filter((message) => !displayed.has(normalizeNoticeRawMessage(message)))
}

function formatRetryDiagnosticLocation(diagnostic: StructuredRetryDiagnostic): string | null {
  const parts: string[] = []
  if (diagnostic.target) parts.push(diagnostic.target)
  if (diagnostic.line) {
    parts.push(
      diagnostic.column
        ? `line ${diagnostic.line}, column ${diagnostic.column}`
        : `line ${diagnostic.line}`,
    )
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function ArtifactRetryDiagnostics({ diagnostics }: { diagnostics: StructuredRetryDiagnostic[] }) {
  if (diagnostics.length === 0) return null

  const orderedDiagnostics = [...diagnostics].sort((left, right) => left.attempt - right.attempt)

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
        Retry Attempts <span className="normal-case tracking-normal opacity-70">({orderedDiagnostics.length})</span>
      </div>
      <div className="space-y-2">
        {orderedDiagnostics.map((diagnostic) => {
          const location = formatRetryDiagnosticLocation(diagnostic)
          const excerptLabel = location ? 'Failing excerpt' : 'Best-effort excerpt'
          return (
            <div
              key={`${diagnostic.attempt}:${diagnostic.validationError}:${diagnostic.excerpt}`}
              className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-xs font-semibold">Attempt {diagnostic.attempt}</div>
                {diagnostic.failureClass ? (
                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                    {diagnostic.failureClass}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 space-y-1 text-[11px] leading-5">
                <div><span className="font-medium">Why:</span> {diagnostic.validationError}</div>
                {location ? (
                  <div><span className="font-medium">Where:</span> {location}</div>
                ) : null}
                <div className="space-y-1">
                  <div className="font-medium">{excerptLabel}:</div>
                  <pre className="overflow-x-auto rounded border border-border bg-background px-2 py-2 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap">
                    {diagnostic.excerpt}
                  </pre>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ArtifactInterventionOwnerBreakdown({
  owners,
}: {
  owners: Array<{ label: string; structuredOutput?: ArtifactStructuredOutputData }>
}) {
  if (owners.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">Affected Models</div>
      <div className="space-y-2">
        {owners.map((owner) => (
          <div key={owner.label} className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50">
            <div className="mb-2 text-xs font-semibold">{owner.label}</div>
            <div className="space-y-3">
              {(() => {
                const interventions = getStructuredOutputInterventions(owner.structuredOutput)
                const retryDiagnostics = normalizeStructuredRetryDiagnostics(owner.structuredOutput?.retryDiagnostics)
                return (
                  <>
                    <ArtifactInterventionBreakdown interventions={interventions} />
                    <ArtifactSourceMessages messages={getUndisplayedSourceMessages(owner.structuredOutput, interventions, retryDiagnostics)} />
                    <ArtifactRetryDiagnostics diagnostics={retryDiagnostics} />
                  </>
                )
              })()}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Exported so the Manual QA view can show the same notice the artifact view
 * shows. The checklist artifact and the surface an operator actually works on
 * during Manual QA are two different screens, and only one of them was showing
 * that the checklist had been repaired.
 */
export function ArtifactProcessingNotice({
  structuredOutput,
  kind,
  context,
  status = 'completed',
}: {
  structuredOutput?: ArtifactStructuredOutputData
  kind?: ArtifactProcessingKind
  context?: ArtifactProcessingNoticeContext
  status?: ArtifactProcessingStatus
}) {
  const copy = buildArtifactProcessingNoticeCopy(structuredOutput, kind, { ...context, status })
  if (!copy) {
    return null
  }
  const hasOwnerInterventions = Boolean(context?.ownerInterventions?.length)
  const shouldShowOnlyOwnerInterventions = kind === 'vote-aggregate' && hasOwnerInterventions
  // Normalised rather than passed through. A stored artifact's diagnostics are
  // whatever was written: this component sorts them on `attempt`, trims their
  // `excerpt` and renders their fields, so a `null` entry or a wrong field type
  // throws here. `normalizeStructuredRetryDiagnostics` was built for exactly
  // this shape and was not being used on the display path — only in
  // `phaseArtifactTypes`' parse path, which not every caller goes through.
  const normalizedDiagnostics = normalizeStructuredRetryDiagnostics(structuredOutput?.retryDiagnostics)
  const retryDiagnostics = kind === 'vote-aggregate' ? [] : normalizedDiagnostics
  const sourceMessages = getUndisplayedSourceMessages(
    structuredOutput,
    copy.interventions,
    normalizedDiagnostics,
  )

  return (
    <CollapsibleWarningNotice
      title={copy.title}
      summary={copy.summary}
      body={(
        <div className="space-y-3">
          <div className="leading-5">{copy.body}</div>
          {!shouldShowOnlyOwnerInterventions ? (
            <>
              <ArtifactInterventionBreakdown interventions={copy.interventions} />
              <ArtifactSourceMessages messages={sourceMessages} />
              <ArtifactRetryDiagnostics diagnostics={retryDiagnostics} />
            </>
          ) : null}
          {context?.ownerInterventions?.length ? (
            <ArtifactInterventionOwnerBreakdown owners={context.ownerInterventions} />
          ) : null}
        </div>
      )}
      headerActions={copy.badges.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {copy.badges.map((badge) => (
            <span key={badge.label} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>
              {badge.label} {badge.count}
            </span>
          ))}
        </div>
      ) : undefined}
    />
  )
}
