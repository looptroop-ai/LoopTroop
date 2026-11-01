import { useMemo } from 'react'
import { mergeEntriesBatch } from '@/context/logUtils'
import type { LogEntry } from '@/context/LogContext'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'
import { useCurrentActivityEvidence } from '@/hooks/useCurrentActivityEvidence'
import { CurrentActivityStrip } from './CurrentActivityStrip'

interface CurrentActivityEvidenceStripProps {
  evidence: ReturnType<typeof useCurrentActivityEvidence>
  suppressNearTimeout?: boolean
  liveEntries: LogEntry[]
}

export function CurrentActivityEvidenceStrip({
  evidence,
  suppressNearTimeout,
  liveEntries,
}: CurrentActivityEvidenceStripProps) {
  const entries = useMemo(() => mergeEntriesBatch(evidence.entries, liveEntries), [evidence.entries, liveEntries])
  return (
    <>
      <CurrentActivityStrip
        entries={entries}
        enabled={evidence.enabled}
        activeStatus={evidence.activeStatus}
        activePhaseAttempt={evidence.activePhaseAttempt}
        suppressNearTimeout={suppressNearTimeout}
      />
      {evidence.errorTitle ? (
        <QueryErrorNotice
          title={evidence.errorTitle}
          error={evidence.error}
          onRetry={evidence.retry}
          className="shrink-0 border-b border-destructive/20 bg-destructive/5"
        />
      ) : null}
    </>
  )
}
