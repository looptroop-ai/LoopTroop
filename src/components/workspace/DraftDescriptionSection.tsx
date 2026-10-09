import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'
import { TicketDescriptionTabs } from '@/components/ticket/TicketDescriptionTabs'
import { TicketDescriptionViewer } from '@/components/ticket/TicketDescriptionViewer'
import { CopyButton } from './RawTextDisplay'
import type { DraftDescription } from './useDraftView'

interface DraftDescriptionProps {
  draft: DraftDescription
}

export const DraftDescriptionSection = ({ draft }: DraftDescriptionProps) => (
  <div className="w-full rounded-md border border-border p-3">
    <DraftDescriptionHeader draft={draft} />
    {draft.isEditing ? <DraftDescriptionEditor draft={draft} /> : <DraftDescriptionPreview draft={draft} />}
  </div>
)

export const DraftDescriptionHeader = ({ draft }: DraftDescriptionProps) => (
  <div className="flex items-center justify-between gap-2">
    <h4 className="text-xs font-medium">Description</h4>
    <div className="flex items-center gap-1.5">
      <TicketDescriptionTabs mode={draft.mode} onModeChange={draft.setMode} />
      {draft.mode === 'raw' && <CopyButton content={draft.text} title="Copy description" />}
      {!draft.isEditing && (
        <Button type="button" variant="outline" size="sm" onClick={draft.handleEdit} disabled={draft.isBusy} className="h-7 px-2 text-[11px]">
          {draft.text ? 'Edit Description' : 'Add Description'}
        </Button>
      )}
    </div>
  </div>
)

export const DraftDescriptionEditor = ({ draft }: DraftDescriptionProps) => (
  <>
    {draft.mode === 'raw' ? (
      <textarea
        aria-label="Ticket description"
        value={draft.text}
        onChange={(event) => draft.setText(event.target.value)}
        className="mt-2 min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        placeholder="Describe what you want to build..."
      />
    ) : <DraftDescriptionEditPreview text={draft.text} />}
    <div className="mt-2 flex justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={draft.handleCancel} disabled={draft.isBusy}>Cancel</Button>
      <Button type="button" size="sm" onClick={draft.handleSave} disabled={draft.isSaveDisabled}>
        {draft.isSaving ? <LoadingText text="Saving" /> : 'Save'}
      </Button>
    </div>
    {draft.error && <p role="alert" aria-live="polite" className="mt-2 text-xs text-destructive">{draft.error}</p>}
  </>
)

export const DraftDescriptionEditPreview = ({ text }: { text: string }) => (
  <div className="mt-2 min-h-[140px] max-h-[300px] overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2">
    {text ? <TicketDescriptionViewer description={text} className="text-xs" /> : <p className="text-xs text-muted-foreground">No description yet.</p>}
  </div>
)

export const DraftDescriptionPreview = ({ draft }: DraftDescriptionProps) => {
  if (!draft.text) return <p className="mt-2 text-xs text-muted-foreground">No description yet. Add more context before starting the ticket.</p>
  return (
    <div className="mt-2 max-h-[300px] overflow-y-auto">
      {draft.mode === 'markdown'
        ? <TicketDescriptionViewer description={draft.text} className="text-xs" />
        : <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{draft.text}</p>}
    </div>
  )
}
