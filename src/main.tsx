import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { installDevApiGuard } from './lib/devApi'
import { installSessionWatch } from './lib/sessionState'
import { consumeBootstrapNonce } from './lib/bootstrapAuth'
import { UIProvider } from './context/UIContext'
import { TooltipProvider } from './components/ui/tooltip'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import { AppCrashScreen } from './components/shared/AppCrashScreen'
import { SessionGate } from './components/shared/SessionGate'
import App from './App'
import './index.css'

installDevApiGuard()
// After the dev guard, which delegates to the fetch it captured at import: a
// watch installed first would be the layer the guard bypasses. Before the nonce
// exchange, so a nonce the daemon refuses is caught by the same one rule.
installSessionWatch()

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found in DOM')
}

// Awaited before render so the first API call already carries the session
// cookie; rendering first would fire unauthenticated requests.
await consumeBootstrapNonce()

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <TooltipProvider>
          <ErrorBoundary fallback={(details) => <AppCrashScreen {...details} />}>
            <SessionGate>
              <App />
            </SessionGate>
          </ErrorBoundary>
        </TooltipProvider>
      </UIProvider>
    </QueryClientProvider>
  </StrictMode>,
)
