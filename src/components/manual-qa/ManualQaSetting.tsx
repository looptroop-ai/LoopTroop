import { PROFILE_DEFAULTS } from '@server/db/defaults'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import { TriStateSetting, type TriStateOption } from '@/components/settings/TriStateSetting'

interface ManualQaSettingProps {
  value: ManualQaOverride
  onChange: (value: ManualQaOverride) => void
  disabled?: boolean
  idPrefix: string
  inheritedEnabled?: boolean
  compact?: boolean
}

// No inherit button: the two choices are the only ones this control offers, and a
// stored `null` resolves to whatever is inherited rather than showing as unset —
// the fallback below is what the radio shows for it. Not choosing is still a
// state: a new ticket is created with `null` and keeps following its project and
// profile, and `DraftView` writes back whatever it was given.
const OPTIONS: readonly TriStateOption[] = [
  {
    value: true,
    label: 'Enabled',
    tooltip: 'After final tests pass, LoopTroop generates a checklist and pauses the ticket for your review. You run and control the application; LoopTroop never launches it. Passing, waiving, or skipping continues to integration, while failures can create QA-fix work. The effective choice is frozen when the ticket starts.',
  },
  {
    value: false,
    label: 'Disabled',
    tooltip: 'After final tests pass, the ticket proceeds directly to integration without a Manual QA checkpoint. No checklist or evidence round is created. Automated tests and the normal integration checks still run. The effective choice is frozen when the ticket starts.',
  },
]

export function ManualQaSetting({
  value,
  onChange,
  disabled = false,
  idPrefix,
  inheritedEnabled,
  compact = false,
}: ManualQaSettingProps) {
  return (
    <TriStateSetting
      value={value}
      onChange={onChange}
      options={OPTIONS}
      groupLabel="Manual QA setting"
      idPrefix={idPrefix}
      fallbackValue={inheritedEnabled ?? PROFILE_DEFAULTS.manualQaEnabled}
      disabled={disabled}
      compact={compact}
      footer={value === null && typeof inheritedEnabled === 'boolean' && (
        <p className="mt-1 text-xs text-muted-foreground">
          Current default: <span className="font-medium text-foreground">{inheritedEnabled ? 'Enabled' : 'Disabled'}</span>. Choose an option to set this explicitly.
        </p>
      )}
    />
  )
}
