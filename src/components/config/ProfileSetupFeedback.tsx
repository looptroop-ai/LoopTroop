import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'
import { Separator } from '@/components/ui/separator'

interface ProfileConnectionStatusProps {
  status: { dotClass: string; label: string } | null
}

export const ProfileConnectionStatus = ({ status }: ProfileConnectionStatusProps) => {
  if (!status) return null
  return <><Separator /><div className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${status.dotClass}`} /><span className="text-xs text-muted-foreground">{status.label}</span></div></>
}

interface ProfileFormActionsProps {
  onOpenAbout?: () => void
  onClose: () => void
  isSaving: boolean
  hasErrors: boolean
}

export const ProfileFormActions = ({ onOpenAbout, onClose, isSaving, hasErrors }: ProfileFormActionsProps) => (
  <div className="flex items-center justify-between gap-2 pt-2">
    <Button type="button" variant="ghost" onClick={onOpenAbout} className="rounded-lg text-muted-foreground hover:text-foreground">About</Button>
    <div className="flex items-center gap-2.5">
      <Button type="button" variant="outline" onClick={onClose} className="rounded-lg">Cancel</Button>
      <Button type="submit" disabled={isSaving || hasErrors} className="rounded-lg bg-foreground text-background font-semibold hover:opacity-95 active:scale-[0.98] shadow-2xs">{isSaving ? <LoadingText text="Saving" /> : 'Save'}</Button>
    </div>
  </div>
)
