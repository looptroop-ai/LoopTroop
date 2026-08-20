import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import type { IgnoreMode } from '@/lib/ignoreMode'
import { cn } from '@/lib/utils'

interface IgnoreModeSettingProps {
  value: IgnoreMode
  onChange: (value: IgnoreMode) => void
  disabled?: boolean
  idPrefix: string
  label?: string
}

const OPTIONS: Array<{ value: IgnoreMode; title: string; description: string }> = [
  {
    value: 'repo',
    title: 'Repository .gitignore',
    description: 'Committed with the repository, so every clone and worktree inherits it.',
  },
  {
    value: 'local',
    title: 'This clone only (.git/info/exclude)',
    description: 'Untracked and private to this machine. Nothing to commit.',
  },
  {
    value: 'skip',
    title: 'Do not change any file',
    description: 'For a repository that already ignores them, or ignores them elsewhere.',
  },
]

export function IgnoreModeSetting({
  value,
  onChange,
  disabled = false,
  idPrefix,
  label = 'Ignore LoopTroop folders',
}: IgnoreModeSettingProps) {
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium">{label}</label>
          <ConfigurationDocsLink
            docsPath="/configuration#looptroop-folder-ignore-policy"
            label={`${idPrefix} folder-ignore policy`}
            description="LoopTroop creates .looptroop/ project state and .ticket/ ticket workspaces. Choose repository-wide rules, private rules for this clone, or no changes. Open the folder-ignore documentation."
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose where to ignore <span className="font-mono">.looptroop/</span> and{' '}
          <span className="font-mono">.ticket/</span>. Rules are appended; existing file content is not changed.
        </p>
      </div>
      <fieldset className="grid gap-2" disabled={disabled}>
        <legend className="sr-only">Ignore location</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer gap-3 rounded-md border bg-background/70 p-3 transition-colors',
              value === option.value
                ? 'border-primary ring-1 ring-primary'
                : 'border-border hover:border-muted-foreground/50',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={`${idPrefix}-ignore-mode`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="block font-medium text-foreground">{option.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {value === 'skip' && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          If these folders are not already ignored, Git will see LoopTroop&apos;s runtime files as changes to commit.
        </p>
      )}
    </div>
  )
}
