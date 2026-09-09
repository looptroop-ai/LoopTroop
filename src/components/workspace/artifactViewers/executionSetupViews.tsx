import { closeTag, openTag, PROTOCOL_TAGS } from '@shared/protocolTags'
import { CopyButton } from '../RawTextDisplay'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelBadge } from '@/components/shared/ModelBadge'
import { formatArtifactTimestampLabel } from './artifactTimestamp'
import { parseExecutionSetupPlanReport, parseExecutionSetupProfile, parseExecutionSetupRuntimeReport } from '../phaseArtifactTypes'
import type { ExecutionSetupPlanReportData, ExecutionSetupProfileData, ExecutionSetupRuntimeReportData } from '../phaseArtifactTypes'
import type { RawContentSource } from './rawContentSources'
import { CheckCircle2, AlertTriangle, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { renderCommandSpec } from '@shared/commandSpec'
import { parseExecutionSetupPlanContent } from '@/lib/executionSetupPlan'
import { RawContentWithCopy } from '../RawTextDisplay'
import { CollapsibleSection } from './CollapsibleSection'
import { ArtifactListSection, MetadataCard } from './MetadataCard'
import { WithRawTab } from './WithRawTab'
import { ArtifactProcessingNotice } from './ArtifactProcessingNotice'
import {
  buildRawAttemptVariants,
  dedupeRawContentVariants,
  formatRawAttemptSourceLabel,
} from './rawAttempts'

const EXECUTION_SETUP_PLAN_ENVELOPE = new RegExp(
  `${openTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)}\\s*([\\s\\S]*?)\\s*${closeTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)}`,
)

function extractExecutionSetupPlanPayloadText(value: string): string {
  const trimmed = value.trim()
  const markerMatch = EXECUTION_SETUP_PLAN_ENVELOPE.exec(trimmed)
  return markerMatch?.[1]?.trim() ?? trimmed
}

function isExecutionSetupModelOutputEquivalentToRawPlan(rawPlanContent: string, modelOutput?: string | null): boolean {
  if (!modelOutput?.trim()) return false

  const normalizedModelOutput = extractExecutionSetupPlanPayloadText(modelOutput)
  if (normalizedModelOutput === rawPlanContent.trim()) return true

  const rawPlan = parseExecutionSetupPlanContent(rawPlanContent).plan
  const modelPlan = parseExecutionSetupPlanContent(normalizedModelOutput).plan
  if (!rawPlan || !modelPlan) return false

  return JSON.stringify(rawPlan) === JSON.stringify(modelPlan)
}

function describeExecutionSetupQualityGatePolicy(
  field: 'tests' | 'lint' | 'typecheck' | 'fullProjectFallback',
  value: string,
): string {
  if (!value.trim()) {
    return 'No default policy text was recorded for this gate.'
  }

  if (field === 'tests') {
    if (value === 'bead-test-commands-first') {
      return 'Later coding beads should start with the bead-specific test commands before broadening to larger suites.'
    }
    return 'Default test gate that later coding beads should try first.'
  }

  if (field === 'lint' || field === 'typecheck') {
    if (value === 'impacted-or-package') {
      return `Prefer ${field === 'lint' ? 'linting' : 'typechecking'} the impacted package, workspace, or narrowed scope before escalating to the whole repository.`
    }
    return `Default ${field === 'lint' ? 'lint' : 'typecheck'} scope guidance for later coding beads.`
  }

  if (value === 'never-block-on-unrelated-baseline') {
    return 'If the full repository already has unrelated baseline debt, later phases should not fail solely because of that unrelated debt.'
  }
  return 'Fallback rule for how later phases should handle broader repository-wide gate failures.'
}

function labelExecutionSetupReadiness(status: 'ready' | 'partial' | 'missing'): string {
  switch (status) {
    case 'ready':
      return 'Ready'
    case 'missing':
      return 'Missing'
    default:
      return 'Partial'
  }
}

export function ExecutionSetupPlanView({
  content,
  reportContent,
  header,
}: {
  content: string
  reportContent?: string | null
  header?: React.ReactNode
}) {
  const { plan, error } = parseExecutionSetupPlanContent(content)
  const report: ExecutionSetupPlanReportData | null = reportContent ? parseExecutionSetupPlanReport(reportContent) : null

  if (!plan || error) {
    return <RawContentWithCopy content={content} />
  }

  const stepCount = plan.steps.length
  const requiredStepCount = plan.steps.filter((step) => step.required).length
  const optionalStepCount = Math.max(stepCount - requiredStepCount, 0)
  const commandCount = plan.steps.reduce((total, step) => total + step.commands.length, 0)
  const workspaceProbeCount = plan.workspaceProbes.length
  const workspaceInputCount = plan.workspaceInputs.length
  const detectedHookCount = plan.gitHooks.detected.length
  const hookValidationCount = plan.gitHooks.validationCommands.length
  const generatedAtLabel = formatArtifactTimestampLabel(report?.generatedAt)
  const readinessLabel = labelExecutionSetupReadiness(plan.readiness.status)
  const readinessTone = plan.readiness.status === 'ready'
    ? 'success'
    : plan.readiness.status === 'missing'
      ? 'danger'
      : 'warning'
  const qualityGateEntries = [
    {
      label: 'Tests',
      value: plan.qualityGatePolicy.tests,
      hint: describeExecutionSetupQualityGatePolicy('tests', plan.qualityGatePolicy.tests),
    },
    {
      label: 'Lint',
      value: plan.qualityGatePolicy.lint,
      hint: describeExecutionSetupQualityGatePolicy('lint', plan.qualityGatePolicy.lint),
    },
    {
      label: 'Typecheck',
      value: plan.qualityGatePolicy.typecheck,
      hint: describeExecutionSetupQualityGatePolicy('typecheck', plan.qualityGatePolicy.typecheck),
    },
    {
      label: 'Fallback',
      value: plan.qualityGatePolicy.fullProjectFallback,
      hint: describeExecutionSetupQualityGatePolicy('fullProjectFallback', plan.qualityGatePolicy.fullProjectFallback),
    },
  ] as const
  const sourceLabel = report?.source === 'regenerate'
    ? 'Regenerated draft'
    : report?.source === 'auto'
      ? 'Initial draft'
      : 'Draft'
  const statusTone = report?.ready === false || report?.status === 'failed'
    ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100'
    : 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
  const errors = report?.errors ?? []
  const notes = report?.notes ?? []
  const failed = report?.ready === false || report?.status === 'failed'
  const modelOutput = report?.modelOutput
  const hasModelOutput = Boolean(modelOutput)
    && !isExecutionSetupModelOutputEquivalentToRawPlan(content, report?.modelOutput)
    && !failed
  const rawSourceLabel = formatRawAttemptSourceLabel('Execution setup plan', report?.generatedBy)
  const rawSources: RawContentSource[] | undefined = report?.modelOutput || report?.rawAttempts?.length
    ? [{
        id: 'execution-setup-plan-model-output',
        label: rawSourceLabel,
        modelId: report?.generatedBy,
        variants: dedupeRawContentVariants([
          ...(report?.modelOutput ? [{
            id: 'execution-setup-plan-model-output:current',
            label: 'Model Output',
            content: report.modelOutput,
            displayContent: report.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show execution setup plan model output',
          }] : []),
          ...buildRawAttemptVariants('execution-setup-plan', rawSourceLabel, report?.rawAttempts),
        ]),
        disabled: !report?.modelOutput && !report?.rawAttempts?.length,
        title: 'Show execution setup plan raw diagnostics',
      }]
    : undefined
  const projectCommandGroups: Array<{ title: string; items: string[]; emptyLabel: string }> = [
    {
      title: 'Prepare Commands',
      items: plan.projectCommands.prepare.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No shared prepare commands were recorded.',
    },
    {
      title: 'Full Test Commands',
      items: plan.projectCommands.testFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full test commands were recorded.',
    },
    {
      title: 'Full Lint Commands',
      items: plan.projectCommands.lintFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full lint commands were recorded.',
    },
    {
      title: 'Full Typecheck Commands',
      items: plan.projectCommands.typecheckFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full typecheck commands were recorded.',
    },
  ]

  const resolvedHeader = report?.generatedBy
    ? (
      <ModelBadge modelId={report.generatedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(report.generatedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">
            {sourceLabel}
            {generatedAtLabel ? ` · ${generatedAtLabel}` : ''}
          </div>
        </div>
      </ModelBadge>
      )
    : header ?? <div className="text-xs font-semibold px-1">Execution Setup Plan</div>

  return (
    <WithRawTab
      content={content}
      structuredLabel="Plan"
      header={resolvedHeader}
      notice={<ArtifactProcessingNotice structuredOutput={report?.structuredOutput} kind="artifact" />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={cn('rounded-md border px-3 py-3', statusTone)}>
          <div className="flex items-start gap-2">
            {report?.ready === false || report?.status === 'failed'
              ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{report?.summary || plan.summary}</div>
              <div className="mt-1 text-xs leading-5">
                {plan.readiness.actionsRequired
                  ? 'Temporary-only setup contract for preparing the workspace before coding begins.'
                  : 'Workspace audited as already ready. Approving this plan keeps execution setup effectively no-op unless you edit the plan later.'}
              </div>
              {(generatedAtLabel || report?.source) ? (
                <div className="mt-2 text-[11px] opacity-80">
                  {sourceLabel}
                  {generatedAtLabel ? ` · ${generatedAtLabel}` : ''}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-10 gap-3">
          <MetadataCard label="Readiness" value={readinessLabel} tone={readinessTone} />
          <MetadataCard label="Actions" value={plan.readiness.actionsRequired ? 'Yes' : 'No'} tone={plan.readiness.actionsRequired ? 'warning' : 'success'} />
          <MetadataCard label="Steps" value={stepCount.toLocaleString()} tone="info" />
          <MetadataCard label="Required" value={requiredStepCount.toLocaleString()} tone={requiredStepCount > 0 ? 'success' : 'default'} />
          <MetadataCard label="Optional" value={optionalStepCount.toLocaleString()} tone={optionalStepCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Commands" value={commandCount.toLocaleString()} tone={commandCount > 0 ? 'info' : 'default'} />
          <MetadataCard label="Workspace Inputs" value={workspaceInputCount.toLocaleString()} tone={workspaceInputCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Workspace Probes" value={workspaceProbeCount.toLocaleString()} tone={workspaceProbeCount > 0 ? 'info' : 'warning'} />
          <MetadataCard label="Detected Hooks" value={detectedHookCount.toLocaleString()} tone={detectedHookCount > 0 ? 'info' : 'default'} />
          <MetadataCard label="Hook Checks" value={hookValidationCount.toLocaleString()} tone={hookValidationCount > 0 ? 'success' : 'default'} />
        </div>

        <CollapsibleSection title="Workspace Verification" defaultOpen>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="space-y-3">
              <ArtifactListSection
                title="Approved Workspace Inputs"
                items={plan.workspaceInputs.map((input) => `${input.path} (${input.kind}, ${input.sourceStatus}, ${input.category}${input.allowLargeCopy ? ', large-copy override' : ''}): ${input.reason}`)}
                emptyLabel="No ignored or untracked workspace inputs were approved."
                tone="default"
              />
              <ArtifactListSection
                title="Workspace Probes"
                items={plan.workspaceProbes.map((probe) => `${probe.id}: ${renderCommandSpec(probe.command, plan.hostContext.preferredShell)}${probe.purpose ? ` — ${probe.purpose}` : ''}`)}
                emptyLabel="No repository-level workspace probes were recorded."
                tone="default"
              />
            </div>
            <div className="space-y-3">
              <MetadataCard label="Git Hook Policy" value={plan.gitHooks.policy.replaceAll('_', ' ')} tone="info" />
              <ArtifactListSection
                title="Detected Git Hooks"
                items={plan.gitHooks.detected.map((hook) => `${hook.name}: ${hook.path} (${hook.kind === 'manager_config' ? 'manager configuration' : 'hook file'}; ${hook.source || 'unknown source'}; runnable ${hook.runnable}${hook.managerHint ? `; ${hook.managerHint}` : ''})`)}
                emptyLabel="No Git hooks were detected."
                tone="default"
              />
              <ArtifactListSection
                title="Git Hook Validation Commands"
                items={plan.gitHooks.validationCommands.map((entry) => `${entry.hook || 'hook'}: ${renderCommandSpec(entry.command, plan.hostContext.preferredShell)}${entry.purpose ? ` — ${entry.purpose}` : ''}`)}
                emptyLabel="No explicit hook validations were approved; hook validation will be recorded as skipped."
                tone="default"
              />
            </div>
          </div>
        </CollapsibleSection>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <ArtifactListSection
            title="Observed Evidence"
            items={plan.readiness.evidence}
            emptyLabel="No readiness evidence was recorded."
            tone="default"
          />
          <ArtifactListSection
            title="Open Gaps"
            items={plan.readiness.gaps}
            emptyLabel={plan.readiness.status === 'ready' ? 'No unresolved setup gaps remain.' : 'No explicit setup gaps were recorded.'}
            tone={plan.readiness.status === 'ready' ? 'preserved' : 'error'}
          />
          <ArtifactListSection
            title="Temporary Roots"
            items={plan.tempRoots}
            emptyLabel="No temporary runtime roots were recorded."
            tone="default"
          />
          <ArtifactListSection
            title="Plan Cautions"
            items={plan.cautions}
            emptyLabel="No plan-level cautions were recorded."
            tone="error"
          />
        </div>

        <CollapsibleSection
          title={(
            <span className="flex items-center gap-2">
              <span>Setup Steps</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{stepCount}</span>
            </span>
          )}
          defaultOpen
        >
          <div className="space-y-3">
            {plan.steps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                No setup steps are proposed for this ticket. The readiness assessment says the current workspace is already sufficient for coding.
              </div>
            ) : (
              plan.steps.map((step, index) => (
                <div key={step.id || index} className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      #{index + 1}
                    </span>
                    <div className="min-w-0 flex-1 text-sm font-semibold">{step.title || `Step ${index + 1}`}</div>
                    <span className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                      step.required
                        ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-200'
                        : 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-200',
                    )}>
                      {step.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground leading-5">{step.purpose}</p>
                  {step.commands.length > 0 ? (
                    <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap">
                      <code>{step.commands.join('\n')}</code>
                    </pre>
                  ) : (
                    <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      No commands were recorded for this step.
                    </div>
                  )}
                  {step.rationale ? (
                    <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Rationale</div>
                      <div className="mt-1 text-xs leading-5">{step.rationale}</div>
                    </div>
                  ) : null}
                  {step.cautions.length > 0 ? (
                    <div className="mt-3">
                      <ArtifactListSection
                        title="Step Cautions"
                        items={step.cautions}
                        emptyLabel="No step cautions were recorded."
                        tone="error"
                      />
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Project Command Families" defaultOpen>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projectCommandGroups.map((group) => (
              <ArtifactListSection
                key={group.title}
                title={group.title}
                items={group.items}
                emptyLabel={group.emptyLabel}
                tone="default"
              />
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Quality Gate Policy" defaultOpen>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {qualityGateEntries.map((entry) => (
              <MetadataCard
                key={entry.label}
                label={entry.label}
                value={entry.value || 'Not specified'}
                hint={entry.hint}
                tone="info"
              />
            ))}
          </div>
        </CollapsibleSection>

        {(notes.length > 0 || errors.length > 0 || hasModelOutput) ? (
          <CollapsibleSection title="Generation Details" defaultOpen={errors.length > 0}>
            <div className="space-y-3">
              {notes.length > 0 ? (
                <ArtifactListSection
                  title="Regenerate Commentary"
                  items={notes}
                  emptyLabel="No regenerate commentary was recorded."
                  tone="default"
                />
              ) : null}

              {errors.length > 0 ? (
                <ArtifactListSection
                  title="Generation Errors"
                  items={errors}
                  emptyLabel="No generation errors were recorded."
                  tone="error"
                />
              ) : null}

              {hasModelOutput ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model Output</div>
                    <CopyButton content={modelOutput ?? ''} title="Copy model output" />
                  </div>
                  <pre className="rounded-md border border-border bg-background p-3 text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto overflow-y-hidden">
                    {modelOutput}
                  </pre>
                </div>
              ) : null}
            </div>
          </CollapsibleSection>
        ) : null}
      </div>
    </WithRawTab>
  )
}

function ExecutionSetupCommandFamilies({
  projectCommands,
}: {
  projectCommands: ExecutionSetupProfileData['projectCommands']
}) {
  const projectCommandGroups: Array<{ title: string; items: string[]; emptyLabel: string }> = [
    {
      title: 'Prepare Commands',
      items: projectCommands.prepare,
      emptyLabel: 'No shared prepare commands were recorded.',
    },
    {
      title: 'Full Test Commands',
      items: projectCommands.testFull,
      emptyLabel: 'No full test commands were recorded.',
    },
    {
      title: 'Full Lint Commands',
      items: projectCommands.lintFull,
      emptyLabel: 'No full lint commands were recorded.',
    },
    {
      title: 'Full Typecheck Commands',
      items: projectCommands.typecheckFull,
      emptyLabel: 'No full typecheck commands were recorded.',
    },
  ]

  return (
    <CollapsibleSection title="Project Command Families" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {projectCommandGroups.map((group) => (
          <ArtifactListSection
            key={group.title}
            title={group.title}
            items={group.items}
            emptyLabel={group.emptyLabel}
            tone="default"
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupQualityGateGrid({
  qualityGatePolicy,
}: {
  qualityGatePolicy: ExecutionSetupProfileData['qualityGatePolicy']
}) {
  const qualityGateEntries = [
    {
      label: 'Tests',
      value: qualityGatePolicy.tests,
      hint: describeExecutionSetupQualityGatePolicy('tests', qualityGatePolicy.tests),
    },
    {
      label: 'Lint',
      value: qualityGatePolicy.lint,
      hint: describeExecutionSetupQualityGatePolicy('lint', qualityGatePolicy.lint),
    },
    {
      label: 'Typecheck',
      value: qualityGatePolicy.typecheck,
      hint: describeExecutionSetupQualityGatePolicy('typecheck', qualityGatePolicy.typecheck),
    },
    {
      label: 'Fallback',
      value: qualityGatePolicy.fullProjectFallback,
      hint: describeExecutionSetupQualityGatePolicy('fullProjectFallback', qualityGatePolicy.fullProjectFallback),
    },
  ] as const

  return (
    <CollapsibleSection title="Quality Gate Policy" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {qualityGateEntries.map((entry) => (
          <MetadataCard
            key={entry.label}
            label={entry.label}
            value={entry.value || 'Not specified'}
            hint={entry.hint}
            tone="info"
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupReusableArtifacts({
  artifacts,
}: {
  artifacts: ExecutionSetupProfileData['reusableArtifacts']
}) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>Reusable Artifacts</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{artifacts.length}</span>
        </span>
      )}
      defaultOpen={artifacts.length > 0}
    >
      {artifacts.length > 0 ? (
        <div className="space-y-2">
          {artifacts.map((artifact, index) => (
            <div key={`${artifact.path}:${index}`} className="rounded-md border border-border bg-background px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono break-all">{artifact.path}</code>
                {artifact.kind ? (
                  <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {artifact.kind}
                  </span>
                ) : null}
              </div>
              {artifact.purpose ? <p className="mt-2 text-xs text-muted-foreground leading-5">{artifact.purpose}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No reusable artifacts were recorded.</div>
      )}
    </CollapsibleSection>
  )
}

function ExecutionSetupProfileSummary({
  profile,
}: {
  profile: ExecutionSetupProfileData
}) {
  const statusReady = profile.status === 'ready'
  const statusTone = statusReady
    ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
    : 'border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100'
  const workspacePassed = profile.workspaceProbeReceipts.filter((receipt) => receipt.status === 'passed').length
  const hooksPassed = profile.gitHooks.validationReceipts.filter((receipt) => receipt.status === 'passed').length

  return (
    <div className="space-y-4">
      <div className={cn('rounded-md border px-3 py-3', statusTone)}>
        <div className="flex items-start gap-2">
          {statusReady
            ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            : <FileCode2 className="h-4 w-4 shrink-0 mt-0.5" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{profile.summary || 'Execution setup profile'}</div>
            <div className="mt-1 text-xs leading-5">
              Reusable workspace runtime guidance for coding beads.
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-11 gap-3">
        <MetadataCard label="Status" value={profile.status || 'Unknown'} tone={statusReady ? 'success' : 'info'} />
        <MetadataCard label="Temp Roots" value={profile.tempRoots.length.toLocaleString()} tone="info" />
        <MetadataCard label="Workspace Inputs" value={profile.workspaceInputs.length.toLocaleString()} tone={profile.workspaceInputs.length > 0 ? 'info' : 'default'} />
        <MetadataCard label="Bootstrap" value={profile.bootstrapCommands.length.toLocaleString()} tone={profile.bootstrapCommands.length > 0 ? 'info' : 'default'} />
        <MetadataCard label="Probes" value={profile.toolingProbeCommands.length.toLocaleString()} tone={profile.toolingProbeCommands.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Workspace Probes" value={profile.workspaceProbes.length.toLocaleString()} tone={profile.workspaceProbes.length > 0 ? 'success' : 'warning'} />
        <MetadataCard label="Hook Checks" value={profile.gitHooks.validationCommands.length.toLocaleString()} tone={profile.gitHooks.validationCommands.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Workspace Results" value={`${workspacePassed}/${profile.workspaceProbeReceipts.length}`} tone={workspacePassed === profile.workspaceProbeReceipts.length && workspacePassed > 0 ? 'success' : 'default'} />
        <MetadataCard label="Hook Results" value={`${hooksPassed}/${profile.gitHooks.validationReceipts.length}`} tone={hooksPassed === profile.gitHooks.validationReceipts.length && hooksPassed > 0 ? 'success' : 'default'} />
        <MetadataCard label="Reusable" value={profile.reusableArtifacts.length.toLocaleString()} tone={profile.reusableArtifacts.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Ticket" value={profile.ticketId || 'Unknown'} mono />
      </div>

      <CollapsibleSection title="Workspace and Git Hook Verification" defaultOpen>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ArtifactListSection
            title="Workspace Probes"
            items={profile.workspaceProbes.map((probe) => `${probe.id}: ${probe.command}${probe.purpose ? ` — ${probe.purpose}` : ''}`)}
            emptyLabel="No repository-level workspace probes were recorded."
          />
          <ArtifactListSection
            title="Approved Workspace Inputs"
            items={profile.workspaceInputs.map((input) => `${input.path} (${input.kind}, ${input.sourceStatus}): ${input.reason}`)}
            emptyLabel="No workspace inputs were approved."
          />
          <ArtifactListSection
            title="Workspace Probe Outcomes"
            items={profile.workspaceProbeReceipts.map((receipt) => `${receipt.id}: ${receipt.status} (${receipt.durationMs}ms${receipt.exitCode == null ? '' : `; exit ${receipt.exitCode}`})${receipt.outputExcerpt ? ` — ${receipt.outputExcerpt}` : ''}`)}
            emptyLabel="No workspace probe outcomes were recorded."
            tone="default"
          />
          <div className="space-y-3">
            <MetadataCard label="Git Hook Policy" value={profile.gitHooks.policy.replaceAll('_', ' ')} tone="info" />
            <ArtifactListSection
              title="Detected Git Hooks"
              items={profile.gitHooks.detected.map((hook) => `${hook.name}: ${hook.path} (${hook.source || 'unknown source'})`)}
              emptyLabel="No Git hooks were detected."
            />
            <ArtifactListSection
              title="Git Hook Validation Commands"
              items={profile.gitHooks.validationCommands.map((entry) => `${entry.hook || 'hook'}: ${entry.command}`)}
              emptyLabel="No explicit hook validation commands were approved."
            />
            <ArtifactListSection
              title="Git Hook Validation Outcomes"
              items={profile.gitHooks.validationReceipts.map((receipt) => `${receipt.id}: ${receipt.status} (${receipt.durationMs}ms${receipt.exitCode == null ? '' : `; exit ${receipt.exitCode}`})${receipt.outputExcerpt ? ` — ${receipt.outputExcerpt}` : ''}`)}
              emptyLabel="No Git-hook validation outcomes were recorded."
            />
          </div>
        </div>
      </CollapsibleSection>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ArtifactListSection
          title="Temporary Roots"
          items={profile.tempRoots}
          emptyLabel="No temporary runtime roots were recorded."
          tone="default"
        />
        <ArtifactListSection
          title="Bootstrap Commands"
          items={profile.bootstrapCommands}
          emptyLabel="No bootstrap commands were recorded."
          tone="default"
        />
        <ArtifactListSection
          title="Tooling Probes"
          items={profile.toolingProbeCommands}
          emptyLabel="No tooling probes were recorded."
          tone="default"
        />
      </div>

      <ExecutionSetupReusableArtifacts artifacts={profile.reusableArtifacts} />
      <ExecutionSetupCommandFamilies projectCommands={profile.projectCommands} />
      <ExecutionSetupQualityGateGrid qualityGatePolicy={profile.qualityGatePolicy} />
      <ArtifactListSection
        title="Cautions"
        items={profile.cautions}
        emptyLabel="No profile cautions were recorded."
        tone="error"
      />
    </div>
  )
}

export function ExecutionSetupProfileView({ content }: { content: string }) {
  const profile = parseExecutionSetupProfile(content)
  if (!profile) {
    return <RawContentWithCopy content={content} />
  }

  return (
    <WithRawTab
      content={content}
      structuredLabel="Profile"
      header={<div className="text-xs font-semibold px-1">Execution Setup Profile</div>}
    >
      <ExecutionSetupProfileSummary profile={profile} />
    </WithRawTab>
  )
}

function getExecutionSetupCheckTone(value: string): 'default' | 'success' | 'warning' | 'danger' | 'info' {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'default'
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'ready' || normalized === 'ok') return 'success'
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') return 'danger'
  return 'warning'
}

export function ExecutionSetupChecksView({
  checks,
}: {
  checks: NonNullable<ExecutionSetupRuntimeReportData['checks']>
}) {
  const entries = [
    { label: 'Workspace', value: checks.workspace },
    { label: 'Tooling', value: checks.tooling },
    { label: 'Temp Scope', value: checks.tempScope },
    { label: 'Policy', value: checks.policy },
  ]

  return (
    <CollapsibleSection title="Checks" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {entries.map((entry) => (
          <MetadataCard
            key={entry.label}
            label={entry.label}
            value={entry.value || 'Not recorded'}
            tone={getExecutionSetupCheckTone(entry.value)}
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupAttemptHistoryView({
  attempts,
}: {
  attempts: ExecutionSetupRuntimeReportData['attemptHistory']
}) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>Attempt History</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{attempts.length}</span>
        </span>
      )}
      defaultOpen={attempts.length > 0}
    >
      {attempts.length > 0 ? (
        <div className="space-y-3">
          {attempts.map((attempt) => {
            const failed = attempt.status === 'failed'
            const checkedAtLabel = formatArtifactTimestampLabel(attempt.checkedAt)
            return (
              <div key={attempt.attempt} className="rounded-md border border-border bg-background px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">Attempt {attempt.attempt}</span>
                  <span className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                    failed
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200'
                      : 'border-green-300 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-200',
                  )}>
                    {attempt.status}
                  </span>
                  {checkedAtLabel ? <span className="text-[11px] text-muted-foreground">{checkedAtLabel}</span> : null}
                </div>
                {attempt.summary ? <p className="mt-2 text-xs text-muted-foreground leading-5">{attempt.summary}</p> : null}
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <ArtifactListSection
                    title="Temp Roots"
                    items={attempt.tempRoots}
                    emptyLabel="No temp roots were recorded for this attempt."
                  />
                  <ArtifactListSection
                    title="Bootstrap Commands"
                    items={attempt.bootstrapCommands}
                    emptyLabel="No bootstrap commands were recorded for this attempt."
                  />
                </div>
                {(attempt.errors.length > 0 || attempt.failureReason || attempt.noteAppended) ? (
                  <div className="mt-3 space-y-3">
                    <ArtifactListSection
                      title="Errors"
                      items={attempt.errors.length > 0 ? attempt.errors : (attempt.failureReason ? [attempt.failureReason] : [])}
                      emptyLabel="No attempt errors were recorded."
                      tone="error"
                    />
                    {attempt.noteAppended ? (
                      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-5">
                        <span className="font-medium text-foreground">Retry note:</span> {attempt.noteAppended}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No attempt history was recorded.</div>
      )}
    </CollapsibleSection>
  )
}

export function ExecutionSetupReportView({ content, runtimeLabel = false }: { content: string; runtimeLabel?: boolean }) {
  const report = parseExecutionSetupRuntimeReport(content)
  if (!report) {
    return <RawContentWithCopy content={content} />
  }

  const failed = report.ready === false || report.status === 'failed'
  const checkedAtLabel = formatArtifactTimestampLabel(report.checkedAt)
  const attemptCount = report.attemptHistory.length || report.attempt || 0
  const statusLabel = failed ? 'failed' : report.status || (report.ready ? 'ready' : 'unknown')
  const statusTone = failed
    ? 'border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100'
    : 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
  const rawSourceLabel = formatRawAttemptSourceLabel('Execution setup', report.preparedBy)
  const rawSources: RawContentSource[] | undefined = report.modelOutput || report.rawAttempts?.length
    ? [{
        id: 'execution-setup-model-output',
        label: rawSourceLabel,
        modelId: report.preparedBy,
        variants: dedupeRawContentVariants([
          ...(report.modelOutput ? [{
            id: 'execution-setup-model-output:current',
            label: 'Model Output',
            content: report.modelOutput,
            displayContent: report.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show execution setup model output',
          }] : []),
          ...buildRawAttemptVariants('execution-setup', rawSourceLabel, report.rawAttempts),
        ]),
        disabled: !report.modelOutput && !report.rawAttempts?.length,
        title: 'Show execution setup raw diagnostics',
      }]
    : undefined
  const header = report.preparedBy
    ? (
      <ModelBadge modelId={report.preparedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(report.preparedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">
            {runtimeLabel ? 'Execution setup runtime' : 'Execution setup report'}
            {checkedAtLabel ? ` · ${checkedAtLabel}` : ''}
          </div>
        </div>
      </ModelBadge>
      )
    : <div className="text-xs font-semibold px-1">{runtimeLabel ? 'Execution Setup Runtime' : 'Execution Setup Report'}</div>

  return (
    <WithRawTab
      content={content}
      structuredLabel={runtimeLabel ? 'Runtime' : 'Report'}
      header={header}
      notice={<ArtifactProcessingNotice structuredOutput={report.structuredOutput} kind="artifact" status={failed ? 'failed' : 'completed'} />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={cn('rounded-md border px-3 py-3', statusTone)}>
          <div className="flex items-start gap-2">
            {failed
              ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{report.summary || (failed ? 'Execution setup failed' : 'Execution setup ready')}</div>
              <div className="mt-1 text-xs leading-5">
                {failed
                  ? 'Workspace runtime setup did not produce an accepted reusable profile.'
                  : 'Workspace runtime setup produced a reusable profile for coding beads.'}
              </div>
              {checkedAtLabel ? <div className="mt-2 text-[11px] opacity-80">Checked at {checkedAtLabel}</div> : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
          <MetadataCard label="Status" value={statusLabel} tone={failed ? 'danger' : 'success'} />
          <MetadataCard label="Ready" value={report.ready === undefined ? 'Unknown' : report.ready ? 'Yes' : 'No'} tone={report.ready ? 'success' : failed ? 'danger' : 'default'} />
          <MetadataCard label="Attempt" value={report.attempt?.toLocaleString() ?? (attemptCount > 0 ? attemptCount.toLocaleString() : 'Unknown')} tone="info" />
          <MetadataCard label="Max Iterations" value={report.maxIterations == null ? 'Unlimited' : report.maxIterations.toLocaleString()} tone="default" />
          <MetadataCard label="Added Commands" value={report.executionAddedCommands.length.toLocaleString()} tone={report.executionAddedCommands.length > 0 ? 'warning' : 'success'} />
        </div>

        {report.checks ? <ExecutionSetupChecksView checks={report.checks} /> : null}

        {report.profile ? (
          <CollapsibleSection title="Profile Snapshot" defaultOpen>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-5">{report.profile.summary || 'No profile summary was recorded.'}</p>
              <div className="grid grid-cols-2 xl:grid-cols-7 gap-3">
                <MetadataCard label="Temp Roots" value={report.profile.tempRoots.length.toLocaleString()} tone="info" />
                <MetadataCard label="Bootstrap" value={report.profile.bootstrapCommands.length.toLocaleString()} tone={report.profile.bootstrapCommands.length > 0 ? 'info' : 'default'} />
                <MetadataCard label="Probes" value={report.profile.toolingProbeCommands.length.toLocaleString()} tone={report.profile.toolingProbeCommands.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Workspace Probes" value={report.profile.workspaceProbes.length.toLocaleString()} tone={report.profile.workspaceProbes.length > 0 ? 'success' : 'warning'} />
                <MetadataCard label="Hook Checks" value={report.profile.gitHooks.validationCommands.length.toLocaleString()} tone={report.profile.gitHooks.validationCommands.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Reusable" value={report.profile.reusableArtifacts.length.toLocaleString()} tone={report.profile.reusableArtifacts.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Status" value={report.profile.status || 'Unknown'} tone={report.profile.status === 'ready' ? 'success' : 'default'} />
              </div>
            </div>
          </CollapsibleSection>
        ) : null}

        <ExecutionSetupAttemptHistoryView attempts={report.attemptHistory} />

        <CollapsibleSection title="Command Audit" defaultOpen={report.executionAddedCommands.length > 0}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ArtifactListSection
              title="Approved Plan Commands"
              items={report.approvedPlanCommands}
              emptyLabel="No approved plan commands were recorded."
            />
            <ArtifactListSection
              title="Execution Added Commands"
              items={report.executionAddedCommands}
              emptyLabel="No additional execution setup commands were recorded."
              tone={report.executionAddedCommands.length > 0 ? 'error' : 'preserved'}
            />
          </div>
        </CollapsibleSection>

        <ArtifactListSection
          title="Retry Notes"
          items={report.retryNotes}
          emptyLabel="No retry notes were recorded."
          tone="default"
        />

        <ArtifactListSection
          title="Worktree Warnings"
          items={report.worktreeWarnings}
          emptyLabel="No worktree warnings were recorded."
          tone="warning"
        />

        <ArtifactListSection
          title="Errors"
          items={report.errors}
          emptyLabel="No execution setup errors were recorded."
          tone="error"
        />

        {report.modelOutput && !failed ? (
          <CollapsibleSection title="Model Output">
            <div className="space-y-2">
              <div className="flex justify-end">
                <CopyButton content={report.modelOutput} title="Copy model output" />
              </div>
              <pre className="rounded-md border border-border bg-background p-3 text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto overflow-y-hidden">
                {report.modelOutput}
              </pre>
            </div>
          </CollapsibleSection>
        ) : null}
      </div>
    </WithRawTab>
  )
}

export function ExecutionSetupRuntimeView({ content }: { content: string }) {
  if (parseExecutionSetupRuntimeReport(content)) {
    return <ExecutionSetupReportView content={content} runtimeLabel />
  }
  if (parseExecutionSetupProfile(content)) {
    return <ExecutionSetupProfileView content={content} />
  }
  return <RawContentWithCopy content={content} />
}
