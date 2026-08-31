import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CommandSpec } from '@shared/commandSpec'
import type {
  ExecutionSetupPlan,
  ExecutionSetupGitHookValidationCommand,
  ExecutionSetupPlanReadiness,
  ExecutionSetupPlanStep,
  ExecutionSetupWorkspaceProbe,
  ExecutionSetupWorkspaceInput,
} from '@/lib/executionSetupPlan'

const GIT_HOOK_POLICY_AUDIT_LABELS: Record<ExecutionSetupPlan['gitHooks']['policy'], string> = {
  observe_only: 'Observe — bypass hooks, no validation',
  validate_advisory: 'Check — warn if validation fails',
  validate_required: 'Require — block if validation fails',
  use_native_hooks: 'Run — allow Git hooks to act normally',
}

function emptyProcessCommand(): CommandSpec {
  return { mode: 'process', program: '', args: [], cwd: '.', env: {} }
}

interface EnvironmentRow {
  id: string
  /** What the field shows — including a name that is not usable yet. */
  name: string
  /** The name this row currently occupies in the plan, or '' if it occupies none. */
  appliedName: string
  value: string
}

let environmentRowSeq = 0
function nextEnvironmentRowId(): string {
  return `env-${++environmentRowSeq}`
}

function toEnvironmentRows(value: Record<string, string>): EnvironmentRow[] {
  return Object.entries(value).map(([name, entryValue]) => ({
    id: nextEnvironmentRowId(),
    name,
    appliedName: name,
    value: entryValue,
  }))
}

/**
 * The plan holds each row under the last name that was usable. A row being renamed
 * onto a name a sibling already has, or not named yet, keeps the one it had.
 */
function toEnvironmentRecord(rows: EnvironmentRow[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    if (row.appliedName === '') continue
    record[row.appliedName] = row.value
  }
  return record
}

function findDuplicateNames(rows: EnvironmentRow[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    if (row.name === '') continue
    if (seen.has(row.name)) duplicates.add(row.name)
    seen.add(row.name)
  }
  return duplicates
}

/** Promotes every row whose typed name is usable; the rest keep the name they hold. */
function settleRows(rows: EnvironmentRow[]): EnvironmentRow[] {
  const duplicates = findDuplicateNames(rows)
  return rows.map((row) => (
    row.name !== '' && !duplicates.has(row.name) && row.appliedName !== row.name
      ? { ...row, appliedName: row.name }
      : row
  ))
}

function sameEnvironmentRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => key in right && left[key] === right[key])
}

/**
 * A `Record<string, string>` cannot describe an environment while it is being edited.
 * Renaming a variable in place meant deleting one key and adding another, so the row
 * jumped to the bottom of the list on every keystroke, the React key changed with the
 * name and remounted the field mid-word — taking focus with it — and renaming `FOO`
 * onto an existing `BAR` silently destroyed both: `FOO` deleted, `BAR` overwritten.
 *
 * Rows with stable ids hold the edit instead, each remembering the name it occupies in
 * the plan. A name a sibling already has is reported and not taken up: that row keeps
 * the name it had, so nothing is dropped or renamed behind the user's back — and,
 * unlike a blanket refusal to emit, every other edit on the form still reaches the
 * plan while the collision is unresolved. The saved plan is still a record.
 */
function EnvironmentEditor({
  value,
  disabled,
  onChange,
}: {
  value: Record<string, string>
  disabled?: boolean
  onChange: (value: Record<string, string>) => void
}) {
  const [rows, setRows] = useState<EnvironmentRow[]>(() => toEnvironmentRows(value))

  // Adopt the incoming record whenever it stops describing these rows — a plan loaded,
  // reset, or changed by anything other than this editor. An edit of our own is already
  // reflected here, and re-deriving rows from it would throw the ids away. Rows always
  // describe a well-formed record now, so an unresolved collision no longer blinds this
  // comparison and cannot leave a stale draft to overwrite a plan loaded underneath it.
  useEffect(() => {
    setRows((current) => (sameEnvironmentRecord(toEnvironmentRecord(current), value) ? current : toEnvironmentRows(value)))
  }, [value])

  const duplicateNames = findDuplicateNames(rows)

  const applyRows = (next: EnvironmentRow[]) => {
    const settled = settleRows(next)
    setRows(settled)
    const record = toEnvironmentRecord(settled)
    if (!sameEnvironmentRecord(record, value)) onChange(record)
  }

  return (
    <div className="space-y-1">
      {rows.map((row, index) => {
        const isDuplicate = duplicateNames.has(row.name)
        return (
          <div key={row.id} className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-1">
              <input
                aria-label={`Environment variable ${index + 1} name`}
                aria-invalid={isDuplicate || undefined}
                value={row.name}
                disabled={disabled}
                onChange={(event) => applyRows(rows.map((r) => (r.id === row.id ? { ...r, name: event.target.value } : r)))}
                className={`rounded-md border bg-background px-2 py-1 font-mono text-xs ${isDuplicate ? 'border-destructive' : 'border-input'}`}
                placeholder="NAME"
              />
              <input
                aria-label={`Environment variable ${index + 1} value`}
                value={row.value}
                disabled={disabled}
                onChange={(event) => applyRows(rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)))}
                className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                placeholder="Value"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove environment variable ${index + 1}`}
                onClick={() => applyRows(rows.filter((r) => r.id !== row.id))}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              >
                ×
              </Button>
            </div>
            {isDuplicate && (
              <p role="alert" className="text-[10px] text-destructive">
                Another variable is already called {row.name}. Rename one of them to save this.
              </p>
            )}
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
        const taken = new Set(rows.map((row) => row.name))
        let name = 'VARIABLE'
        let suffix = 1
        while (taken.has(name)) name = `VARIABLE_${++suffix}`
        applyRows([...rows, { id: nextEnvironmentRowId(), name, appliedName: '', value: '' }])
      }} className="h-7 text-xs">+ Variable</Button>
    </div>
  )
}

function CommandSpecEditor({
  command,
  disabled,
  label,
  onChange,
}: {
  command: CommandSpec
  disabled?: boolean
  label: string
  onChange: (command: CommandSpec) => void
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/10 p-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Mode
          <select
            aria-label={`${label} mode`}
            value={command.mode}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === 'shell'
              ? { mode: 'shell', shell: 'posix', script: '', cwd: command.cwd, env: command.env, ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}) }
              : { mode: 'process', program: '', args: [], cwd: command.cwd, env: command.env, ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}) })}
            className="block w-full rounded-md border border-input bg-background px-2 py-1 text-xs normal-case tracking-normal text-foreground"
          >
            <option value="process">Direct process (preferred)</option>
            <option value="shell">Shell script</option>
          </select>
        </label>
        {command.mode === 'shell' ? (
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Shell
            <select aria-label={`${label} shell`} value={command.shell} disabled={disabled} onChange={(event) => onChange({ ...command, shell: event.target.value as 'posix' | 'cmd' | 'powershell' })} className="block w-full rounded-md border border-input bg-background px-2 py-1 text-xs normal-case tracking-normal text-foreground">
              <option value="posix">POSIX (sh)</option>
              <option value="powershell">PowerShell</option>
              <option value="cmd">Windows Command Prompt</option>
            </select>
          </label>
        ) : (
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Program
            <input aria-label={`${label} program`} value={command.program} disabled={disabled} onChange={(event) => onChange({ ...command, program: event.target.value })} className="block w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs normal-case tracking-normal text-foreground" placeholder="Executable name or path" />
          </label>
        )}
      </div>
      {command.mode === 'shell' ? (
        <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Script
          <textarea aria-label={`${label} script`} value={command.script} disabled={disabled} onChange={(event) => onChange({ ...command, script: event.target.value })} rows={3} className="block w-full resize-y rounded-md border border-input bg-background px-2 py-1 font-mono text-xs normal-case tracking-normal text-foreground" />
        </label>
      ) : (
        <div>
          <SectionLabel>Arguments</SectionLabel>
          <StringListEditor items={command.args} onChange={(args) => onChange({ ...command, args })} disabled={disabled} placeholder="One argument (spaces are preserved)" />
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Working directory
          <input aria-label={`${label} working directory`} value={command.cwd} disabled={disabled} onChange={(event) => onChange({ ...command, cwd: event.target.value })} className="block w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs normal-case tracking-normal text-foreground" placeholder="." />
        </label>
        <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timeout (milliseconds)
          <input aria-label={`${label} timeout`} type="number" min={100} max={1_800_000} value={command.timeoutMs ?? ''} disabled={disabled} onChange={(event) => {
            const next = { ...command }
            if (event.target.value) next.timeoutMs = Number(event.target.value)
            else delete next.timeoutMs
            onChange(next)
          }} className="block w-full rounded-md border border-input bg-background px-2 py-1 text-xs normal-case tracking-normal text-foreground" placeholder="Optional, max 1800000" />
        </label>
      </div>
      <div>
        <SectionLabel>Environment</SectionLabel>
        <EnvironmentEditor value={command.env} onChange={(env) => onChange({ ...command, env })} disabled={disabled} />
      </div>
    </div>
  )
}

function CommandListEditor({
  items,
  disabled,
  label,
  onChange,
}: {
  items: CommandSpec[]
  disabled?: boolean
  label: string
  onChange: (items: CommandSpec[]) => void
}) {
  return (
    <div className="space-y-2">
      {items.map((command, index) => (
        <div key={index} className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-muted-foreground">{label} {index + 1}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${label} ${index + 1}`} disabled={disabled} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">×</Button>
          </div>
          <CommandSpecEditor command={command} disabled={disabled} label={`${label} ${index + 1}`} onChange={(nextCommand) => onChange(items.map((item, itemIndex) => itemIndex === index ? nextCommand : item))} />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...items, emptyProcessCommand()])} className="h-7 text-xs">+ Command</Button>
    </div>
  )
}

function StringListEditor({
  items,
  onChange,
  placeholder,
  disabled,
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-1">
          <textarea
            value={item}
            onChange={(event) => {
              const next = [...items]
              next[index] = event.target.value
              onChange(next)
            }}
            disabled={disabled}
            rows={1}
            className="flex-1 min-h-[28px] rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
            placeholder={placeholder}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            disabled={disabled}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...items, ''])}
        disabled={disabled}
        className="text-xs h-7"
      >
        + Add
      </Button>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">{children}</label>
}

function PolicyField({
  label,
  value,
  description,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  value: string
  description: string
  placeholder: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/20 p-2">
      <div>
        <div className="text-[11px] font-semibold text-foreground">{label}</div>
        <div className="text-[10px] leading-4 text-muted-foreground">{description}</div>
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        placeholder={placeholder}
      />
    </div>
  )
}

function CommandRecordEditor<T extends { id: string; command: CommandSpec; purpose: string }>({
  title,
  items,
  disabled,
  emptyLabel,
  createItem,
  onChange,
  extraField,
}: {
  title: string
  items: T[]
  disabled?: boolean
  emptyLabel: string
  createItem: (index: number) => T
  onChange: (items: T[]) => void
  extraField?: { label: string; key: keyof T; placeholder: string }
}) {
  const updateItem = (index: number, update: Partial<T>) => onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...update } : item))
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const currentItem = next[index]
    const targetItem = next[target]
    if (!currentItem || !targetItem) return
    next[index] = targetItem
    next[target] = currentItem
    onChange(next)
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
          <Badge variant="outline" className="h-5 text-[10px]">{items.length}</Badge>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...items, createItem(items.length)])} className="h-7 text-xs">
          Add
        </Button>
      </div>
      {items.length === 0 ? <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">{emptyLabel}</div> : null}
      {items.map((item, index) => (
        <div key={`${item.id}-${index}`} className="space-y-2 rounded-md border border-border bg-muted/10 p-2">
          <div className="flex items-center gap-1">
            <input aria-label={`${title} ${index + 1} id`} value={item.id} disabled={disabled} onChange={(event) => updateItem(index, { id: event.target.value } as Partial<T>)} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs" placeholder="Stable id" />
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${title} ${index + 1} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)} className="h-7 w-7 p-0">↑</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${title} ${index + 1} down`} disabled={disabled || index === items.length - 1} onClick={() => move(index, 1)} className="h-7 w-7 p-0">↓</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${title} ${index + 1}`} disabled={disabled} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">×</Button>
          </div>
          {extraField ? (
            <input aria-label={`${title} ${index + 1} ${extraField.label}`} value={String(item[extraField.key] ?? '')} disabled={disabled} onChange={(event) => updateItem(index, { [extraField.key]: event.target.value } as Partial<T>)} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" placeholder={extraField.placeholder} />
          ) : null}
          <CommandSpecEditor command={item.command} disabled={disabled} label={`${title} ${index + 1} command`} onChange={(command) => updateItem(index, { command } as Partial<T>)} />
          <input aria-label={`${title} ${index + 1} purpose`} value={item.purpose} disabled={disabled} onChange={(event) => updateItem(index, { purpose: event.target.value } as Partial<T>)} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" placeholder="Why this command is needed" />
        </div>
      ))}
    </div>
  )
}

function WorkspaceInputEditor({
  items,
  disabled,
  onChange,
}: {
  items: ExecutionSetupWorkspaceInput[]
  disabled?: boolean
  onChange: (items: ExecutionSetupWorkspaceInput[]) => void
}) {
  const updateItem = (index: number, update: Partial<ExecutionSetupWorkspaceInput>) => {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...update } : item))
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace Inputs</div>
          <Badge variant="outline" className="h-5 text-[10px]">{items.length}</Badge>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...items, { path: '', kind: 'file', sourceStatus: 'ignored', category: 'other_non_reproducible', reason: '' }])}
          className="h-7 text-xs"
        >
          Add
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          No ignored or untracked workspace inputs are approved.
        </div>
      ) : null}
      {items.map((item, index) => (
        <div key={`${item.path}-${index}`} className="space-y-2 rounded-md border border-border bg-muted/10 p-2">
          <div className="flex items-center gap-2">
            <input
              aria-label={`Workspace input ${index + 1} path`}
              value={item.path}
              disabled={disabled}
              onChange={(event) => updateItem(index, { path: event.target.value })}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
              placeholder="Repository-relative path"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove workspace input ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            >
              ×
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <select
              aria-label={`Workspace input ${index + 1} kind`}
              value={item.kind}
              disabled={disabled}
              onChange={(event) => updateItem(index, { kind: event.target.value as ExecutionSetupWorkspaceInput['kind'] })}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="file">File</option>
              <option value="directory">Directory</option>
            </select>
            <select
              aria-label={`Workspace input ${index + 1} source status`}
              value={item.sourceStatus}
              disabled={disabled}
              onChange={(event) => updateItem(index, { sourceStatus: event.target.value as ExecutionSetupWorkspaceInput['sourceStatus'] })}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="ignored">Ignored</option>
              <option value="untracked">Untracked</option>
            </select>
            <select
              aria-label={`Workspace input ${index + 1} category`}
              value={item.category}
              disabled={disabled}
              onChange={(event) => updateItem(index, { category: event.target.value as ExecutionSetupWorkspaceInput['category'] })}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="local_config">Local configuration</option>
              <option value="secret">Secret</option>
              <option value="fixture">Fixture</option>
              <option value="dataset">Dataset</option>
              <option value="other_non_reproducible">Other non-reproducible input</option>
            </select>
          </div>
          <input
            aria-label={`Workspace input ${index + 1} reason`}
            value={item.reason}
            disabled={disabled}
            onChange={(event) => updateItem(index, { reason: event.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
            placeholder="Why setup needs this path"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              aria-label={`Workspace input ${index + 1} allow large copy`}
              checked={item.allowLargeCopy === true}
              disabled={disabled}
              onChange={(event) => updateItem(index, { allowLargeCopy: event.target.checked || undefined })}
            />
            Allow this input to exceed the normal copy-size limit after reviewing its preview
          </label>
        </div>
      ))}
    </div>
  )
}

function createEmptySetupStep(index: number): ExecutionSetupPlanStep {
  const stepNumber = index + 1
  return {
    id: `setup-step-${stepNumber}`,
    title: `Setup Step ${stepNumber}`,
    purpose: '',
    commands: [],
    required: true,
    rationale: '',
    cautions: [],
  }
}

function applyReadinessStatus(
  readiness: ExecutionSetupPlanReadiness,
  status: ExecutionSetupPlanReadiness['status'],
): ExecutionSetupPlanReadiness {
  return {
    ...readiness,
    status,
    actionsRequired: status !== 'ready',
    gaps: status === 'ready' ? [] : readiness.gaps,
  }
}

interface ExecutionSetupPlanEditorProps {
  plan: ExecutionSetupPlan
  disabled?: boolean
  onChange: (plan: ExecutionSetupPlan) => void
}

export function ExecutionSetupPlanEditor({ plan, disabled, onChange }: ExecutionSetupPlanEditorProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(plan.steps.length > 0 ? 0 : null)

  const updatePlan = useCallback((update: Partial<ExecutionSetupPlan>) => {
    onChange({
      ...plan,
      ...update,
    })
  }, [onChange, plan])

  const updateStep = useCallback((index: number, update: Partial<ExecutionSetupPlanStep>) => {
    const nextSteps = plan.steps.map((step, stepIndex) => (
      stepIndex === index ? { ...step, ...update } : step
    ))
    updatePlan({ steps: nextSteps })
  }, [plan.steps, updatePlan])

  const updateReadiness = useCallback((update: Partial<ExecutionSetupPlanReadiness>) => {
    const nextStatus = update.status ?? plan.readiness.status
    const nextReadiness = applyReadinessStatus({
      ...plan.readiness,
      ...update,
    }, nextStatus)
    updatePlan({ readiness: nextReadiness })
  }, [plan.readiness, updatePlan])

  const addStep = useCallback(() => {
    const nextIndex = plan.steps.length
    const nextStatus = plan.readiness.status === 'ready' ? 'partial' : plan.readiness.status
    updatePlan({
      readiness: applyReadinessStatus(plan.readiness, nextStatus),
      steps: [...plan.steps, createEmptySetupStep(nextIndex)],
    })
    setExpandedIndex(nextIndex)
  }, [plan.readiness, plan.steps, updatePlan])

  const removeStep = useCallback((index: number) => {
    const nextSteps = plan.steps.filter((_, stepIndex) => stepIndex !== index)
    const nextReadiness = nextSteps.length === 0 && plan.workspaceInputs.length === 0
      ? applyReadinessStatus(plan.readiness, 'ready')
      : applyReadinessStatus(plan.readiness, plan.readiness.status === 'ready' ? 'partial' : plan.readiness.status)
    updatePlan({
      readiness: nextReadiness,
      steps: nextSteps,
    })
    setExpandedIndex((current) => {
      if (current == null) return null
      if (nextSteps.length === 0) return null
      if (current === index) return Math.min(index, nextSteps.length - 1)
      if (current > index) return current - 1
      return current
    })
  }, [plan.readiness, plan.steps, plan.workspaceInputs.length, updatePlan])

  const updateWorkspaceInputs = useCallback((workspaceInputs: ExecutionSetupWorkspaceInput[]) => {
    const hasActions = workspaceInputs.length > 0 || plan.steps.length > 0
    const status = hasActions
      ? plan.readiness.status === 'ready' ? 'partial' : plan.readiness.status
      : 'ready'
    updatePlan({
      workspaceInputs,
      readiness: applyReadinessStatus(plan.readiness, status),
    })
  }, [plan.readiness, plan.steps.length, updatePlan])

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
        <div className="font-semibold">Structured setup-plan editor</div>
        <p className="mt-1 text-xs leading-5 text-amber-900/80 dark:text-amber-200/90">
          Review the readiness assessment, approved workspace inputs, and setup steps before approval.
          Use the raw tab for full-power editing.
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px]" aria-label="Current setup host">
          <Badge variant="outline">{plan.hostContext.platform}</Badge>
          <Badge variant="outline">{plan.hostContext.environment}</Badge>
          <Badge variant="outline">{plan.hostContext.arch}</Badge>
          <Badge variant="outline">available shells: {plan.hostContext.availableShells.join(', ')}</Badge>
          <Badge variant="outline">preferred shell: {plan.hostContext.preferredShell}</Badge>
        </div>
      </div>

      <WorkspaceInputEditor
        items={plan.workspaceInputs}
        disabled={disabled}
        onChange={updateWorkspaceInputs}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <SectionLabel>Summary</SectionLabel>
          <textarea
            value={plan.summary}
            onChange={(event) => updatePlan({ summary: event.target.value })}
            disabled={disabled}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
          />
        </div>
        <div>
          <SectionLabel>Temp Roots</SectionLabel>
          <StringListEditor
            items={plan.tempRoots}
            onChange={(tempRoots) => updatePlan({ tempRoots })}
            disabled={disabled}
            placeholder=".ticket/runtime/execution-setup or .ticket/runtime/execution-setup/tool-cache"
          />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <CommandRecordEditor<ExecutionSetupWorkspaceProbe>
          title="Workspace Probes"
          items={plan.workspaceProbes}
          disabled={disabled}
          emptyLabel="No repository-level workspace probes are recorded."
          createItem={(index) => ({ id: `workspace-probe-${index + 1}`, command: emptyProcessCommand(), purpose: '' })}
          onChange={(workspaceProbes) => updatePlan({ workspaceProbes })}
        />
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          <div>
            <SectionLabel>Git Hook Policy (read-only)</SectionLabel>
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2" aria-label="Locked Git hook policy">
              <div className="text-xs font-medium">{GIT_HOOK_POLICY_AUDIT_LABELS[plan.gitHooks.policy]}</div>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Locked from the project when this ticket started. Editing the plan cannot change it.
              </p>
            </div>
          </div>
          <div>
            <SectionLabel>Detected Git Hooks (read-only)</SectionLabel>
            {plan.gitHooks.detected.length === 0 ? (
              <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">No Git hooks were detected.</div>
            ) : (
              <div className="space-y-2">
                {plan.gitHooks.detected.map((hook, index) => (
                  <div key={`${hook.path}-${index}`} className="rounded border border-border bg-muted/20 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{hook.name}</span><Badge variant="outline" className="h-5 text-[10px]">{hook.kind === 'manager_config' ? 'manager configuration' : 'hook file'}</Badge><Badge variant={hook.runnable === 'yes' ? 'outline' : 'secondary'} className="h-5 text-[10px]">runnable: {hook.runnable}</Badge>{hook.managerHint ? <Badge variant="outline" className="h-5 text-[10px]">{hook.managerHint}</Badge> : null}</div>
                    <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{hook.path}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">Source: {hook.source || 'unknown'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <CommandRecordEditor<ExecutionSetupGitHookValidationCommand>
        title="Git Hook Validation Commands"
        items={plan.gitHooks.validationCommands}
        disabled={disabled}
        emptyLabel="No explicit Git-hook validation commands are approved. This is allowed and will be recorded as skipped."
        createItem={(index) => ({ id: `git-hook-validation-${index + 1}`, hook: '', command: emptyProcessCommand(), purpose: '' })}
        extraField={{ label: 'hook', key: 'hook', placeholder: 'Hook name, for example pre-commit' }}
        onChange={(validationCommands) => updatePlan({ gitHooks: { ...plan.gitHooks, validationCommands } })}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <SectionLabel>Readiness Status</SectionLabel>
              <select
                value={plan.readiness.status}
                onChange={(event) => updateReadiness({
                  status: event.target.value as ExecutionSetupPlanReadiness['status'],
                })}
                disabled={disabled}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="ready">Ready</option>
                <option value="partial">Partial</option>
                <option value="missing">Missing</option>
              </select>
              {plan.readiness.status === 'ready' && (plan.steps.length > 0 || plan.workspaceInputs.length > 0) ? (
                <div className="mt-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                  Ready status requires removing all setup steps and workspace inputs before saving.
                </div>
              ) : null}
            </div>
            <Badge variant={plan.readiness.actionsRequired ? 'default' : 'outline'} className="h-5 text-[10px] shrink-0">
              {plan.readiness.actionsRequired ? 'actions required' : 'no actions required'}
            </Badge>
          </div>
          <div>
            <SectionLabel>Observed Evidence</SectionLabel>
            <StringListEditor
              items={plan.readiness.evidence}
              onChange={(evidence) => updateReadiness({ evidence })}
              disabled={disabled}
              placeholder="Observed repository or runtime evidence..."
            />
          </div>
          <div>
            <SectionLabel>Open Gaps</SectionLabel>
            <StringListEditor
              items={plan.readiness.gaps}
              onChange={(gaps) => updateReadiness({ gaps })}
              disabled={disabled || plan.readiness.status === 'ready'}
              placeholder="Missing prerequisite or unresolved setup gap..."
            />
          </div>
        </div>

        <div>
          <SectionLabel>Plan Cautions</SectionLabel>
          <StringListEditor
            items={plan.cautions}
            onChange={(cautions) => updatePlan({ cautions })}
            disabled={disabled}
            placeholder="Potential risk or caveat..."
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <SectionLabel>Prepare / Bootstrap Commands</SectionLabel>
          <CommandListEditor
            items={plan.projectCommands.prepare}
            onChange={(prepare) => updatePlan({ projectCommands: { ...plan.projectCommands, prepare } })}
            disabled={disabled}
            label="Prepare command"
          />
        </div>
        <div>
          <SectionLabel>Full Test Commands</SectionLabel>
          <CommandListEditor
            items={plan.projectCommands.testFull}
            onChange={(testFull) => updatePlan({ projectCommands: { ...plan.projectCommands, testFull } })}
            disabled={disabled}
            label="Full test command"
          />
        </div>
        <div>
          <SectionLabel>Full Lint Commands</SectionLabel>
          <CommandListEditor
            items={plan.projectCommands.lintFull}
            onChange={(lintFull) => updatePlan({ projectCommands: { ...plan.projectCommands, lintFull } })}
            disabled={disabled}
            label="Full lint command"
          />
        </div>
        <div>
          <SectionLabel>Full Typecheck Commands</SectionLabel>
          <CommandListEditor
            items={plan.projectCommands.typecheckFull}
            onChange={(typecheckFull) => updatePlan({ projectCommands: { ...plan.projectCommands, typecheckFull } })}
            disabled={disabled}
            label="Full typecheck command"
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <SectionLabel>Quality Gate Policy</SectionLabel>
          <div className="space-y-2 rounded-lg border border-border bg-background p-3">
            <PolicyField
              label="Tests"
              value={plan.qualityGatePolicy.tests}
              description="Default testing strategy for later coding beads."
              placeholder="bead-test-commands-first"
              disabled={disabled}
              onChange={(tests) => updatePlan({ qualityGatePolicy: { ...plan.qualityGatePolicy, tests } })}
            />
            <PolicyField
              label="Lint"
              value={plan.qualityGatePolicy.lint}
              description="How broadly lint should run before escalating to repo-wide commands."
              placeholder="impacted-or-package"
              disabled={disabled}
              onChange={(lint) => updatePlan({ qualityGatePolicy: { ...plan.qualityGatePolicy, lint } })}
            />
            <PolicyField
              label="Typecheck"
              value={plan.qualityGatePolicy.typecheck}
              description="How broadly typecheck should run before escalating to repo-wide commands."
              placeholder="impacted-or-package"
              disabled={disabled}
              onChange={(typecheck) => updatePlan({ qualityGatePolicy: { ...plan.qualityGatePolicy, typecheck } })}
            />
            <PolicyField
              label="Fallback"
              value={plan.qualityGatePolicy.fullProjectFallback}
              description="What later phases should do if broad repo-wide gates fail because of unrelated baseline debt."
              placeholder="never-block-on-unrelated-baseline"
              disabled={disabled}
              onChange={(fullProjectFallback) => updatePlan({ qualityGatePolicy: { ...plan.qualityGatePolicy, fullProjectFallback } })}
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Setup Steps</div>
            <Badge variant="outline" className="h-5 text-[10px]">{plan.steps.length}</Badge>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addStep}
            disabled={disabled}
            className="text-xs"
          >
            Add Step
          </Button>
        </div>

        {plan.steps.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
            {plan.readiness.actionsRequired
              ? plan.workspaceInputs.length > 0
                ? 'The approved workspace inputs are the only required setup action.'
                : 'No setup steps are recorded yet. Add the missing temporary steps before saving.'
              : 'No setup steps are recorded because the current readiness assessment says no actions are required. Add a step if you want LoopTroop to run extra temporary preparation.'}
          </div>
        ) : null}

        {plan.steps.map((step, index) => {
          const expanded = expandedIndex === index
          return (
            <div key={step.id || index} id={`execution-setup-step-${index}`} className="rounded-lg border border-border bg-background">
              <button
                type="button"
                onClick={() => setExpandedIndex(expanded ? null : index)}
                className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-accent/30 rounded-t-lg"
              >
                <span className="bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
                  #{index + 1}
                </span>
                <span className="text-xs font-medium truncate flex-1">{step.title || `Step ${index + 1}`}</span>
                <Badge variant={step.required ? 'default' : 'outline'} className="h-4 text-[10px]">
                  {step.required ? 'required' : 'optional'}
                </Badge>
                <span className="text-muted-foreground text-[10px]">{expanded ? '▼' : '▶'}</span>
              </button>
              {expanded ? (
                <div className="px-3 pb-3 pt-3 border-t border-border space-y-3">
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeStep(index)}
                      disabled={disabled}
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove Step
                    </Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <SectionLabel>Step Id</SectionLabel>
                      <input
                        value={step.id}
                        onChange={(event) => updateStep(index, { id: event.target.value })}
                        disabled={disabled}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <SectionLabel>Title</SectionLabel>
                      <input
                        value={step.title}
                        onChange={(event) => updateStep(index, { title: event.target.value })}
                        disabled={disabled}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <SectionLabel>Purpose</SectionLabel>
                    <textarea
                      value={step.purpose}
                      onChange={(event) => updateStep(index, { purpose: event.target.value })}
                      disabled={disabled}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
                    />
                  </div>
                  <div>
                    <SectionLabel>Commands</SectionLabel>
                    <CommandListEditor
                      items={step.commands}
                      onChange={(commands) => updateStep(index, { commands })}
                      disabled={disabled}
                      label="Setup command"
                    />
                  </div>
                  <div>
                    <SectionLabel>Rationale</SectionLabel>
                    <textarea
                      value={step.rationale}
                      onChange={(event) => updateStep(index, { rationale: event.target.value })}
                      disabled={disabled}
                      rows={3}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
                    />
                  </div>
                  <div>
                    <SectionLabel>Step Cautions</SectionLabel>
                    <StringListEditor
                      items={step.cautions}
                      onChange={(cautions) => updateStep(index, { cautions })}
                      disabled={disabled}
                      placeholder="Optional caution..."
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={step.required}
                      disabled={disabled}
                      onChange={(event) => updateStep(index, { required: event.target.checked })}
                    />
                    Required step
                  </label>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
