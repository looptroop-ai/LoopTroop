import { useMemo } from 'react'
import { WithRawTab } from './WithRawTab'
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RawContentView } from './RawContentView'

interface PreFlightCheck {
  name: string
  category: string
  result: 'pass' | 'fail' | 'warning'
  message: string
  details?: string
}

interface PreFlightReportData {
  passed: boolean
  checks: PreFlightCheck[]
  criticalFailures: PreFlightCheck[]
  warnings: PreFlightCheck[]
}

const CATEGORY_LABELS: Record<string, string> = {
  connectivity: 'Connectivity',
  git: 'Git',
  artifacts: 'Artifacts',
  config: 'Configuration',
  graph: 'Dependency Graph',
}

const CATEGORY_ORDER = ['connectivity', 'git', 'artifacts', 'config', 'graph']

export function PreFlightReportView({ content }: { content: string }) {
  const report = useMemo<PreFlightReportData | null>(() => {
    try {
      return JSON.parse(content) as PreFlightReportData
    } catch {
      return null
    }
  }, [content])

  const grouped = useMemo(() => {
    if (!report) return []
    const map = new Map<string, PreFlightCheck[]>()
    for (const check of report.checks) {
      const existing = map.get(check.category) ?? []
      existing.push(check)
      map.set(check.category, existing)
    }
    return CATEGORY_ORDER
      .filter(cat => map.has(cat))
      .map(cat => ({ category: cat, checks: map.get(cat)! }))
  }, [report])

  if (!report) {
    return <RawContentView content={content} />
  }

  return (
    <WithRawTab content={content} structuredLabel="Report">
      <div className="space-y-4">
        <div className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-2',
          report.passed
            ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400'
            : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400',
        )}>
          {report.passed
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <XCircle className="h-4 w-4 shrink-0" />}
          <span className="text-sm font-medium">
            {report.passed
              ? `All checks passed (${report.checks.length} checks)`
              : `Pre-flight failed — ${report.criticalFailures.length} critical issue${report.criticalFailures.length === 1 ? '' : 's'}`}
          </span>
          {report.warnings.length > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400 ml-auto">
              {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {grouped.map(({ category, checks }) => (
          <div key={category} className="space-y-1">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {CATEGORY_LABELS[category] ?? category}
            </div>
            <div className="space-y-0.5">
              {checks.map((check, i) => (
                <div key={`${check.name}-${i}`} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs">
                  {check.result === 'pass' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />}
                  {check.result === 'fail' && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />}
                  {check.result === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <div className={cn(
                      'font-medium',
                      check.result === 'fail' && 'text-red-700 dark:text-red-400',
                      check.result === 'warning' && 'text-amber-700 dark:text-amber-400',
                    )}>
                      {check.message}
                    </div>
                    {check.details && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{check.details}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </WithRawTab>
  )
}
