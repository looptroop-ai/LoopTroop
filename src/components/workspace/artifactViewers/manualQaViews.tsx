import type { ManualQaArtifactChecklist } from './manualQaArtifact'
import { Badge } from '@/components/ui/badge'
import { formatArtifactTimestampLabel } from './artifactTimestamp'

export function ManualQaChecklistArtifactView({ parsed }: { parsed: ManualQaArtifactChecklist }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Manual QA checklist</p>
          {parsed.version !== null && <Badge variant="outline">Round v{parsed.version}</Badge>}
          <Badge variant="secondary">{parsed.items.length} check{parsed.items.length === 1 ? '' : 's'}</Badge>
        </div>
        {parsed.generatedAt && <p className="mt-1 text-xs text-muted-foreground">Generated {formatArtifactTimestampLabel(parsed.generatedAt)}</p>}
        {parsed.summary && <p className="mt-2 text-sm text-muted-foreground">{parsed.summary}</p>}
      </div>

      {parsed.items.map((item, index) => (
        <section key={item.id || index} className="space-y-3 rounded-md border border-border p-3">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h4 className="text-sm font-semibold">{index + 1}. {item.title || item.behavior || item.id}</h4>
              <div className="flex flex-wrap gap-1">
                <Badge variant={item.severity === 'required' ? 'default' : 'outline'}>{item.severity}</Badge>
                <Badge variant="secondary">{item.source.replace(/_/g, ' ')}</Badge>
                {item.recheckState && item.recheckState !== 'new' && <Badge variant="outline">{item.recheckState.replace(/_/g, ' ')}</Badge>}
              </div>
            </div>
            {item.behavior && item.behavior !== item.title && <p className="mt-1 text-xs text-muted-foreground">{item.behavior}</p>}
          </div>
          {item.prerequisites.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prerequisites</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{item.prerequisites.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ul></div>}
          <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</p><ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{item.actions.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ol></div>
          <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-300">Expected result</p><p className="mt-1 text-sm">{item.expectedResult}</p></div>
          {item.watchNotes.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Watch for</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{item.watchNotes.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ul></div>}
          {(item.prdRefs.length > 0 || item.beadRefs.length > 0) && <div className="flex flex-wrap gap-1">{item.prdRefs.map((reference) => <Badge key={`${reference.ref}:${reference.coverage}`} variant="outline">{reference.ref}{reference.coverage ? ` · ${reference.coverage}` : ''}</Badge>)}{item.beadRefs.map((reference) => <Badge key={reference} variant="outline">{reference}</Badge>)}</div>}
        </section>
      ))}

      {parsed.notApplicablePrdRefs.length > 0 && (
        <section className="rounded-md border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not applicable to Manual QA</p>
          <dl className="mt-2 space-y-2 text-xs">{parsed.notApplicablePrdRefs.map((entry) => <div key={entry.ref}><dt className="font-mono font-medium">{entry.ref}</dt><dd className="text-muted-foreground">{entry.reason}</dd></div>)}</dl>
        </section>
      )}
    </div>
  )
}
