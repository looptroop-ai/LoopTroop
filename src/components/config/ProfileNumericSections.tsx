import { Separator } from "@/components/ui/separator"
import { NumericField, type NumericFieldProps } from "./profileNumericUtils"

interface ProfileNumericSectionsProps {
  rawNumeric: Record<string, string>
  onChange: NumericFieldProps["onChange"]
}

export const ProfileNumericSections = ({ rawNumeric, onChange }: ProfileNumericSectionsProps) => (
  <>
    {/* ── OpenCode Provider Recovery ── */}
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">OpenCode Provider Recovery</div>
    <p className="mb-3 text-xs text-muted-foreground">
      Handles OpenCode rate-limit, usage-limit, overload, timeout, and network retry events across all phases.
    </p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <NumericField fieldKey="opencodeRetryLimit" rawNumeric={rawNumeric} onChange={onChange} hint="Continuable OpenCode retry events before blocking any phase prompt (0 to 50)." />
      <NumericField fieldKey="opencodeRetryDelay" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum OpenCode retry grace window before blocking any phase prompt (0 to 3600s)." />
      <NumericField fieldKey="opencodeSteps" rawNumeric={rawNumeric} onChange={onChange} hint="Max steps per OpenCode session (0 = no limit, OpenCode default). Each step ≈ 2 messages in the log." />
    </div>

    <Separator />

    {/* ── AI Thinking ── */}
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">AI Thinking</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <NumericField
        fieldKey="councilResponseTimeout"
        rawNumeric={rawNumeric}
        onChange={onChange}
        hint="Wait time for planning and other AI-only responses (10 to 3600s)."
        tooltip="Applies to planning and other AI-only responses. It does not apply to coding attempts or pre-implementation workspace setup; use Per-Iteration Timeout and Execution Setup Timeout for those."
      />
      <NumericField fieldKey="minCouncilQuorum" rawNumeric={rawNumeric} onChange={onChange} hint="Minimum council votes required (1 to 6)" />
    </div>
    <div className="mt-3">
      <NumericField fieldKey="interviewQuestions" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum initial clarifying questions (0 to 50; keep above 0 for normal runs)." />
    </div>
    <div className="mt-3">
      <NumericField fieldKey="structuredRetryCount" rawNumeric={rawNumeric} onChange={onChange} hint="Retries after invalid structured output (0 to 5)." />
    </div>

    <Separator />

    {/* ── Coverage ── */}
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Coverage</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <NumericField fieldKey="coverageFollowUpBudgetPercent" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum interview follow-up budget for interview coverage passes (0 to 100%)." />
      <NumericField fieldKey="maxCoveragePasses" rawNumeric={rawNumeric} onChange={onChange} hint="Interview coverage executions allowed before approval fallback (1 to 10)." />
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
      <NumericField fieldKey="maxPrdCoveragePasses" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum PRD coverage executions before approval fallback (2 to 20)." />
      <NumericField fieldKey="maxBeadsCoveragePasses" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum beads coverage executions before approval fallback (2 to 20)." />
    </div>

    <Separator />

    {/* ── Implementation & Workspace Setup ── */}
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Implementation &amp; Workspace Setup</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <NumericField fieldKey="maxIterations" rawNumeric={rawNumeric} onChange={onChange} hint="Maximum automatic retries per bead during coding (0 to 20). Final test retries use the same limit." />
      <NumericField fieldKey="perIterationTimeout" rawNumeric={rawNumeric} onChange={onChange} hint="Timeout for each attempt (10 to 3600s)" />
    </div>
    <div className="mt-3">
      <NumericField
        fieldKey="executionSetupTimeout"
        rawNumeric={rawNumeric}
        onChange={onChange}
        hint="Total active-work budget for each workspace setup attempt before coding starts (0 to 3600s)."
        tooltip="This is the maximum total active-work time for one pre-implementation workspace setup attempt. Progress continuations and result corrections share the same budget; every genuine retry receives a fresh full budget."
      />
    </div>

    <Separator />

    {/* ── Logging ── */}
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Logging</div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <NumericField fieldKey="toolInputMaxChars" rawNumeric={rawNumeric} onChange={onChange} hint="Max characters for tool input in logs (500 to 50K)." />
      <NumericField fieldKey="toolOutputMaxChars" rawNumeric={rawNumeric} onChange={onChange} hint="Max characters for tool output in logs (1K to 100K)." />
      <NumericField fieldKey="toolErrorMaxChars" rawNumeric={rawNumeric} onChange={onChange} hint="Max characters for tool error in logs (500 to 50K)." />
    </div>

    <Separator />

  </>
)
