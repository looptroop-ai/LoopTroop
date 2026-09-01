import { sanitizeErrorForDisplay } from '@shared/errorDisplay'

export interface ErrorBannerProps {
  errorMessage: string
}

export function ErrorBanner({ errorMessage }: ErrorBannerProps) {
  const displayError = sanitizeErrorForDisplay(errorMessage) || 'No readable error details were captured.'
  return (
    <div className="col-span-2 border-t-[2px] border-border/70 pt-2 mt-1">
      <span className="text-xs font-medium text-muted-foreground">Error</span>
      <div className="mt-1 max-h-32 overflow-y-auto rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2">
        <p className="text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono">{displayError}</p>
      </div>
    </div>
  )
}
