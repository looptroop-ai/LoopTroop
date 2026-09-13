import { useState } from 'react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { ErrorBoundaryDetails } from './ErrorBoundary'

export function AppCrashScreen({ error, componentStack }: ErrorBoundaryDetails) {
  const [showDetails, setShowDetails] = useState(false)

  const detailText = [
    error?.name && `Error: ${error.name}`,
    error?.message && `Message: ${error.message}`,
    error?.stack && `\nStack trace:\n${error.stack}`,
    componentStack && `\nComponent stack:${componentStack}`,
  ]
    .filter(Boolean)
    .join('\n')
  const [copied, copy, copyFailed, copyFailureCount] = useCopyToClipboard(undefined, detailText)

  return (
    <div className="flex min-h-screen items-center justify-center p-8 text-center">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-bold text-destructive">App crashed</h1>
        <p className="mt-2 text-muted-foreground">Something went wrong. Please refresh the page.</p>

        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Refresh
          </button>
          {error && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
              aria-expanded={showDetails}
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
          )}
        </div>

        {showDetails && error && (
          <div className="mt-4 text-left">
            {error.message && (
              <p className="mb-2 break-words text-sm font-medium text-destructive">{error.message}</p>
            )}
            <pre className="max-h-80 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 text-left text-[11px] leading-relaxed text-destructive whitespace-pre-wrap">
              {detailText}
            </pre>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { void copy(detailText) }}
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
              >
                {copied ? 'Copied' : 'Copy details'}
              </button>
              {copyFailed && <span key={copyFailureCount} role="alert" className="shrink-0 whitespace-nowrap text-xs text-destructive">Copy failed</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
