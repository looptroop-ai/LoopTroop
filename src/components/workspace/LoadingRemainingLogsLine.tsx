import { LoadingText } from '@/components/ui/LoadingText'

export function LoadingRemainingLogsLine() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pb-1 text-muted-foreground/60 italic"
    >
      <LoadingText text="Loading remaining logs" />
    </div>
  )
}
