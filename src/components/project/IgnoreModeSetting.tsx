import type { ReactNode } from 'react'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { IgnoreMode } from '@/lib/ignoreMode'
import { cn } from '@/lib/utils'

interface IgnoreModeSettingProps {
  value: IgnoreMode
  onChange: (value: IgnoreMode) => void
  disabled?: boolean
  idPrefix: string
  label?: string
  description?: ReactNode
}

const OPTIONS: Array<{ value: IgnoreMode; label: string; tooltip: string }> = [
  {
    value: 'repo',
    label: 'Repository',
    tooltip: "Appends the rules to the repository's tracked .gitignore. It is committed with the repository, so every clone and worktree inherits it — and collaborators see the change in a diff.",
  },
  {
    value: 'local',
    label: 'This clone',
    tooltip: "Recommended default. Appends the rules to this clone's Git exclude file, normally .git/info/exclude. It is untracked and private to this machine, so no tracked file changes and there is nothing to commit.",
  },
  {
    value: 'skip',
    label: 'Nowhere',
    tooltip: "Writes no ignore rules at all. For a repository that already ignores these folders, or ignores them elsewhere. If it does not, Git will report LoopTroop's runtime files as changes to commit.",
  },
]

const DEFAULT_DESCRIPTION = (
  <>
    Choose where to ignore <span className="font-mono">.looptroop/</span> and{' '}
    <span className="font-mono">.ticket/</span>. Rules are appended; existing file content is not changed.
  </>
)

export function IgnoreModeSetting({
  value,
  onChange,
  disabled = false,
  idPrefix,
  label = 'Folder-ignore policy',
  description = DEFAULT_DESCRIPTION,
}: IgnoreModeSettingProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <label className="text-sm font-medium">{label}</label>
            <ConfigurationDocsLink
              docsPath="/configuration#looptroop-folder-ignore-policy"
              label={`${idPrefix} folder-ignore policy`}
              description="LoopTroop creates .looptroop/ project state and .ticket/ ticket workspaces. Choose repository-wide rules, private rules for this clone, or no changes. Open the folder-ignore documentation."
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div
          className="inline-flex rounded-md border border-input bg-muted/30 p-0.5"
          role="radiogroup"
          aria-label="Folder-ignore policy"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === value
            return (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    id={`${idPrefix}-ignore-${option.value}`}
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
      </div>
      {value === 'skip' && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          If these folders are not already ignored, Git will see LoopTroop&apos;s runtime files as changes to commit.
        </p>
      )}
    </div>
  )
}
