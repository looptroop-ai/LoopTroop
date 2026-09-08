import { commandSpecSchema } from '@shared/commandSpec'
import { tryParseStructuredContent } from '../phaseArtifactTypes'
import type { FinalTestExecutionReportData } from '../phaseArtifactTypes'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelBadge } from '@/components/shared/ModelBadge'
import type { RawContentSource } from './rawContentSources'
import { Badge } from '@/components/ui/badge'
import { renderCommandSpec } from '@shared/commandSpec'
import { RawContentWithCopy } from '../RawTextDisplay'
import { CollapsibleSection } from './CollapsibleSection'
import { LabeledSubsection } from './LabeledSubsection'
import { WithRawTab } from './WithRawTab'
import { ArtifactProcessingNotice } from './ArtifactProcessingNotice'
import {
  buildRawAttemptVariants,
  dedupeRawContentVariants,
  formatRawAttemptSourceLabel,
} from './rawAttempts'

export function FinalTestResultsView({ content }: { content: string }) {
  const parsed = tryParseStructuredContent(content) as FinalTestExecutionReportData | null
  if (
    !parsed
    || typeof parsed !== 'object'
    || !Array.isArray(parsed.commands)
    || !Array.isArray(parsed.errors)
    || typeof parsed.modelOutput !== 'string'
  ) {
    return <RawContentWithCopy content={content} />
  }

  const checkedAtLabel = Number.isNaN(Date.parse(parsed.checkedAt))
    ? parsed.checkedAt
    : new Date(parsed.checkedAt).toLocaleString()
  const header = parsed.plannedBy
    ? (
      <ModelBadge modelId={parsed.plannedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(parsed.plannedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">Final test results</div>
        </div>
      </ModelBadge>
      )
    : <div className="text-xs font-semibold px-1">Final Test Results</div>
  const rawSourceLabel = formatRawAttemptSourceLabel('final test generation', parsed.plannedBy)
  const rawSources: RawContentSource[] | undefined = parsed.modelOutput || parsed.rawAttempts?.length
    ? [{
        id: 'final-test-model-output',
        label: rawSourceLabel,
        modelId: parsed.plannedBy,
        variants: dedupeRawContentVariants([
          ...(parsed.modelOutput ? [{
            id: 'final-test-model-output:current',
            label: 'Model Output',
            content: parsed.modelOutput,
            displayContent: parsed.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show final-test model output',
          }] : []),
          ...buildRawAttemptVariants('final-test', rawSourceLabel, parsed.rawAttempts),
        ]),
        disabled: !parsed.modelOutput && !parsed.rawAttempts?.length,
        title: 'Show final-test raw diagnostics',
      }]
    : undefined

  return (
    <WithRawTab
      content={content}
      structuredLabel="Results"
      header={header}
      notice={<ArtifactProcessingNotice structuredOutput={parsed.planStructuredOutput} kind="final-test" />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={`rounded-md border px-3 py-2 text-xs font-medium ${
          parsed.passed
            ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200'
            : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
        }`}>
          {parsed.passed ? 'Final test commands passed' : 'Final test commands failed'}
        </div>

        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Checked at {checkedAtLabel}.
          {parsed.summary ? ` Summary: ${parsed.summary}` : ''}
        </div>

        {parsed.testFiles && parsed.testFiles.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Test Files</div>
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs font-mono text-foreground space-y-0.5">
              {parsed.testFiles.map((file, i) => (
                <div key={i}>{file}</div>
              ))}
            </div>
          </div>
        )}

        {parsed.fileEffects && parsed.fileEffects.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">File Effects</div>
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground space-y-1">
              {parsed.fileEffects.map((effect, i) => (
                <div key={`${effect.path}:${effect.intent}:${i}`} className="flex flex-wrap gap-2">
                  <span className="font-mono">{effect.path}</span>
                  <Badge variant="outline" className="text-[10px]">{effect.intent}</Badge>
                  {effect.reason ? <span className="text-muted-foreground">{effect.reason}</span> : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {parsed.commands.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Executed Commands</div>
            {parsed.commands.map((command, index) => {
              const commandLabel = command.displayCommand?.trim()
                || (typeof command.command === 'string'
                  ? command.command
                  : (() => {
                      const structuredCommand = commandSpecSchema.safeParse(command.command)
                      return structuredCommand.success ? renderCommandSpec(structuredCommand.data) : 'Unknown command'
                    })())
              const commandStatus = command.timedOut
                ? 'Timed Out'
                : command.exitCode === 0
                  ? 'Passed'
                  : 'Failed'
              return (
                <CollapsibleSection
                  key={`${commandLabel}:${index}`}
                  title={(
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px]">{commandLabel}</span>
                      <span className="text-[10px] text-muted-foreground">{commandStatus}</span>
                      <span className="text-[10px] text-muted-foreground">{command.durationMs}ms</span>
                    </span>
                  )}
                >
                  <div className="space-y-2">
                    <div className="text-[11px] text-muted-foreground">
                      Exit code: {command.exitCode ?? 'none'}
                      {command.signal ? ` · Signal: ${command.signal}` : ''}
                      {command.setupWrapperApplied ? ' · Setup wrapper applied' : ''}
                    </div>
                    {command.effectiveCommand ? (
                      <LabeledSubsection label="Effective Command">
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.effectiveCommand}
                        </pre>
                      </LabeledSubsection>
                    ) : null}
                    {command.stdout ? (
                      <LabeledSubsection label="Stdout">
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.stdout}
                        </pre>
                      </LabeledSubsection>
                    ) : null}
                    {command.stderr ? (
                      <LabeledSubsection label="Stderr">
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.stderr}
                        </pre>
                      </LabeledSubsection>
                    ) : null}
                  </div>
                </CollapsibleSection>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No final test commands were executed.
          </div>
        )}

        {parsed.errors.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Errors</div>
            <div className="space-y-2">
              {parsed.errors.map((error, index) => (
                <div key={`${error}:${index}`} className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                  {error}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </WithRawTab>
  )
}
