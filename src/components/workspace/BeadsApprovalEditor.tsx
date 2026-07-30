import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CommandSpec } from '@shared/commandSpec'
import { CommandSpecListEditor } from './CommandSpecListEditor'

export interface ParsedBead {
  id: string
  title: string
  prdRefs: string[]
  description: string
  contextGuidance: { patterns: string[]; anti_patterns: string[] }
  acceptanceCriteria: string[]
  tests: string[]
  testCommands: CommandSpec[]
  testCommandReason?: string
  targetFiles: string[]
  dependencies: { blocked_by: string[]; blocks: string[] }
  [key: string]: unknown
}

interface BeadsApprovalEditorProps {
  beads: ParsedBead[]
  disabled?: boolean
  onChange: (beads: ParsedBead[]) => void
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
            onChange={(e) => {
              const next = [...items]
              next[index] = e.target.value
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
            onClick={() => onChange(items.filter((_, i) => i !== index))}
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

export function BeadsApprovalEditor({ beads, disabled, onChange }: BeadsApprovalEditorProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  const updateBead = useCallback((index: number, update: Partial<ParsedBead>) => {
    const next = beads.map((bead, i) => {
      if (i !== index) return bead
      const merged = { ...bead }
      for (const [key, value] of Object.entries(update)) {
        merged[key] = value
      }
      return merged
    })
    onChange(next)
  }, [beads, onChange])

  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
        <div className="font-semibold">Structured beads editor</div>
        <p className="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-200/90">
          Edit semantic fields like title, description, and acceptance criteria. Runtime/derived fields are shown read-only.
          Use the JSONL tab for full-power editing.
        </p>
      </div>
      <div className="text-xs text-muted-foreground mb-2">{beads.length} beads — click to expand and edit</div>
      {beads.map((bead, index) => {
        const isExpanded = expandedIndex === index
        return (
          <div
            key={bead.id || index}
            id={`bead-${index}`}
            className="rounded-lg border border-border bg-background"
          >
            <button
              type="button"
              onClick={() => setExpandedIndex(isExpanded ? null : index)}
              className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent/30 rounded-t-lg"
            >
              <span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
                #{index + 1}
              </span>
              <span className="text-xs font-medium truncate flex-1">{bead.title || `Bead ${index + 1}`}</span>
              <Badge variant="outline" className="text-[10px] h-4">{String(bead.status || 'pending')}</Badge>
              <span className="text-muted-foreground text-[10px]">{isExpanded ? '▼' : '▶'}</span>
            </button>
            {isExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                {/* Title */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Title</label>
                  <input
                    value={bead.title}
                    onChange={(e) => updateBead(index, { title: e.target.value })}
                    disabled={disabled}
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Description</label>
                  <textarea
                    value={bead.description}
                    onChange={(e) => updateBead(index, { description: e.target.value })}
                    disabled={disabled}
                    rows={3}
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
                  />
                </div>

                {/* Acceptance Criteria */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Acceptance Criteria</label>
                  <StringListEditor items={bead.acceptanceCriteria} onChange={(items) => updateBead(index, { acceptanceCriteria: items })} disabled={disabled} placeholder="Criterion..." />
                </div>

                {/* Tests */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Tests</label>
                  <StringListEditor items={bead.tests} onChange={(items) => updateBead(index, { tests: items })} disabled={disabled} placeholder="Test specification..." />
                </div>

                {/* Planned Test Commands */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Planned Test Commands</label>
                  <CommandSpecListEditor
                    commands={bead.testCommands}
                    onChange={(commands) => updateBead(index, {
                      testCommands: commands,
                      ...(commands.length > 0 ? { testCommandReason: undefined } : {}),
                    })}
                    disabled={disabled}
                  />
                </div>

                {bead.testCommands.length === 0 && (
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Why no automated command applies</label>
                    <textarea
                      value={bead.testCommandReason ?? ''}
                      onChange={(e) => updateBead(index, { testCommandReason: e.target.value })}
                      disabled={disabled}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
                      placeholder="Explain why this bead has no appropriate automated command..."
                    />
                  </div>
                )}

                {/* Target Files */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Target Files</label>
                  <StringListEditor items={bead.targetFiles} onChange={(items) => updateBead(index, { targetFiles: items })} disabled={disabled} placeholder="src/file.ts" />
                </div>

                {/* Context Guidance */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Context Guidance — Patterns</label>
                  <StringListEditor items={bead.contextGuidance.patterns} onChange={(items) => updateBead(index, { contextGuidance: { ...bead.contextGuidance, patterns: items } })} disabled={disabled} placeholder="Pattern..." />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Context Guidance — Anti-patterns</label>
                  <StringListEditor items={bead.contextGuidance.anti_patterns} onChange={(items) => updateBead(index, { contextGuidance: { ...bead.contextGuidance, anti_patterns: items } })} disabled={disabled} placeholder="Anti-pattern..." />
                </div>

                {/* PRD Refs */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">PRD References</label>
                  <StringListEditor items={bead.prdRefs} onChange={(items) => updateBead(index, { prdRefs: items })} disabled={disabled} placeholder="EPIC-1, US-1-1..." />
                </div>

                {/* Dependencies: blocked_by */}
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 block mb-1">Blocked By</label>
                  <StringListEditor items={bead.dependencies.blocked_by} onChange={(items) => updateBead(index, { dependencies: { ...bead.dependencies, blocked_by: items } })} disabled={disabled} placeholder="bead-id..." />
                </div>

                {/* Read-only metadata */}
                <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 mb-1">Metadata (read-only)</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                    <span className="text-muted-foreground">ID:</span><span className="font-mono">{bead.id}</span>
                    <span className="text-muted-foreground">Issue Type:</span><span>{String(bead.issueType || 'task')}</span>
                    <span className="text-muted-foreground">Priority:</span><span>{String(bead.priority ?? index + 1)}</span>
                    {bead.externalRef ? <><span className="text-muted-foreground">External Ref:</span><span className="font-mono">{String(bead.externalRef)}</span></> : null}
                    {Array.isArray(bead.labels) && bead.labels.length > 0 && <><span className="text-muted-foreground">Labels:</span><span>{(bead.labels as string[]).join(', ')}</span></>}
                    {bead.dependencies.blocks.length > 0 && <><span className="text-muted-foreground">Blocks:</span><span className="font-mono">{bead.dependencies.blocks.join(', ')}</span></>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
