import { Button } from '@/components/ui/button'
import { AutosaveStatus } from './AutosaveStatus'
import type { ApprovalAutosaveStatus } from './approvalHooks'

interface ApprovalEditToolbarProps<TTab extends string> {
  /** The editor modes this artifact offers, in display order. */
  tabs: ReadonlyArray<{ id: TTab; label: string }>
  activeTab: TTab
  onTabChange: (tab: TTab) => void
  autosave: ApprovalAutosaveStatus
  onSave: () => void
  isSaving: boolean
  saveDisabled: boolean
}

/**
 * The row above every approval editor: mode tabs, the autosave indicator, Save.
 *
 * Four panes carried a copy. They differed only in the two tab labels and, in
 * one case, an extra condition on the Save button — which is exactly the kind of
 * difference that stops being visible when the copies sit in four files, and is
 * why one of them silently disagreed about when saving was allowed.
 */
export function ApprovalEditToolbar<TTab extends string>({
  tabs,
  activeTab,
  onTabChange,
  autosave,
  onSave,
  isSaving,
  saveDisabled,
}: ApprovalEditToolbarProps<TTab>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={activeTab === tab.id
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <AutosaveStatus
          state={autosave.state}
          lastSavedAt={autosave.lastSavedAt}
          label="Draft autosave on"
        />
        <Button size="sm" variant="secondary" onClick={onSave} disabled={saveDisabled}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
