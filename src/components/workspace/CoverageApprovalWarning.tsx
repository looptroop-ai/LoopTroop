import { CollapsibleSection } from './ArtifactContentViewer'
import type { CoverageApprovalWarningData } from './coverageApprovalWarningUtils'
import { Button } from '@/components/ui/button'
import { SkipReasonField } from './SkipReasonField'

export function CoverageApprovalWarning({
  warning,
  onFixGaps,
  isFixing = false,
  fixError = null,
  gapReason,
  onGapReasonChange,
  gapReasonDisabled = false,
}: {
  warning: CoverageApprovalWarningData
  onFixGaps?: () => void
  isFixing?: boolean
  fixError?: string | null
  gapReason?: string
  onGapReasonChange?: (value: string) => void
  gapReasonDisabled?: boolean
}) {
  return (
    <CollapsibleSection
      title={<span className="font-semibold">Coverage Warning</span>}
      className="border-amber-300 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/20"
      triggerClassName="text-amber-950 hover:bg-amber-100/80 dark:text-amber-100 dark:hover:bg-amber-900/30"
      contentClassName="space-y-3 text-amber-950 dark:text-amber-100"
      scrollOnOpen={false}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-amber-300/80 bg-background/80 px-3 py-2 text-xs dark:border-amber-800/80 dark:bg-background/30">
          {warning.summary}
        </div>

        {warning.latestExtraFixSummary ? (
          <div className="rounded-md border border-amber-300/80 bg-background/80 px-3 py-2 text-xs dark:border-amber-800/80 dark:bg-background/30">
            {warning.latestExtraFixSummary}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Final Candidate
          </div>
          <div className="rounded-md border border-amber-300/80 bg-background/80 px-3 py-2 text-xs dark:border-amber-800/80 dark:bg-background/30">
            {warning.candidateLabel}
          </div>
        </div>

        {warning.gaps.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
              Remaining Gaps
            </div>
            <div className="space-y-2">
              {warning.gaps.map((gap, index) => (
                <div
                  key={`${gap}-${index}`}
                  className="rounded-md border border-amber-300/80 bg-background/80 px-3 py-2 text-xs dark:border-amber-800/80 dark:bg-background/30"
                >
                  {gap}
                </div>
              ))}
            </div>
          </div>
        )}

        {warning.gaps.length > 0 && onFixGaps ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onFixGaps}
              disabled={isFixing}
              className="text-xs"
            >
              {isFixing ? 'Fixing gaps...' : warning.extraFixCount > 0 ? 'Fix remaining gaps with AI' : 'Fix gaps with AI'}
            </Button>
            {warning.extraFixCount > 0 ? (
              <span className="text-[11px] text-amber-800 dark:text-amber-300">
                {warning.extraFixCount === 1 ? '1 extra fix attempted' : `${warning.extraFixCount} extra fixes attempted`}
              </span>
            ) : null}
          </div>
        ) : null}

        {fixError ? (
          <div className="rounded-md border border-red-300 bg-red-50/80 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
            {fixError}
          </div>
        ) : null}

        {warning.gaps.length > 0 && onGapReasonChange ? (
          <SkipReasonField
            label="Why approve with these gaps"
            value={gapReason ?? ''}
            onChange={onGapReasonChange}
            disabled={gapReasonDisabled}
            placeholder="Optional. Recorded with the approval."
            help="Whoever reads this approval later sees this, and nothing else explains the gaps."
          />
        ) : null}
      </div>
    </CollapsibleSection>
  )
}
