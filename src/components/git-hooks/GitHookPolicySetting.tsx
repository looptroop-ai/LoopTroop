import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import {
  normalizeGitHookPolicySetting,
  type GitHookPolicyOverride,
} from '@/lib/gitHookPolicySetting'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface GitHookPolicySettingProps {
  value: GitHookPolicyOverride
  onChange: (value: GitHookPolicy) => void
  inheritedPolicy?: GitHookPolicy
  disabled?: boolean
  compact?: boolean
}

const OPTIONS: Array<{ value: GitHookPolicy; label: string; tooltip: string }> = [
  {
    value: 'observe_only',
    label: 'Observe',
    tooltip: 'LoopTroop records detected hooks but bypasses them on its own commits and pushes. It does not run separate validation commands, so hooks cannot block this ticket.',
  },
  {
    value: 'validate_advisory',
    label: 'Check',
    tooltip: 'Recommended default. LoopTroop bypasses native hooks and runs the approved checks visibly. A failed or timed-out check produces a warning but does not block the ticket.',
  },
  {
    value: 'validate_required',
    label: 'Require',
    tooltip: 'LoopTroop bypasses native hooks and runs the approved checks visibly. A failed or timed-out check blocks the ticket until it is resolved.',
  },
  {
    value: 'use_native_hooks',
    label: 'Run',
    tooltip: 'Git runs repository hooks normally on LoopTroop commits and pushes. A hook can block or modify those operations, so use this only when the hooks are reliable in the ticket worktree.',
  },
]

export function GitHookPolicySetting({
  value,
  onChange,
  inheritedPolicy = 'validate_advisory',
  disabled = false,
  compact = false,
}: GitHookPolicySettingProps) {
  const selectedValue = normalizeGitHookPolicySetting(value)
    ?? normalizeGitHookPolicySetting(inheritedPolicy)
    ?? 'validate_advisory'

  return (
    <div>
      <div
        className="inline-flex rounded-md border border-input bg-muted/30 p-0.5"
        role="radiogroup"
        aria-label="Git hook policy"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === selectedValue
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-label={option.label}
                  aria-checked={selected}
                  data-state={selected ? 'checked' : 'unchecked'}
                  disabled={disabled}
                  onClick={() => onChange(option.value)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    selected
                      ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-background hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {option.label}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs leading-relaxed">
                {option.tooltip}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      {!compact && value === null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Inherited default is selected. Choose a button to override it here.
        </p>
      )}
    </div>
  )
}
