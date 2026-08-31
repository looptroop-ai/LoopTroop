import React from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LogActionsContext, LogStateContext } from '@/context/logContextDef'
import type { LogContextValue } from '@/context/logUtils'

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  })
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: {
    queryClient?: QueryClient
    withTooltip?: boolean
  },
) {
  const queryClient = options?.queryClient ?? createTestQueryClient()
  const withTooltip = options?.withTooltip ?? true

  let wrapped = ui
  if (withTooltip) {
    wrapped = React.createElement(TooltipProvider, null, wrapped)
  }
  wrapped = React.createElement(QueryClientProvider, { client: queryClient }, wrapped)

  return { ...render(wrapped), queryClient }
}

/**
 * Publishes one hand-built log context to both halves of the real split, so a test
 * can keep describing the context as a single object while the app subscribes to
 * the two it actually has.
 */
export function withLogContext(value: LogContextValue, ui: React.ReactNode): React.ReactElement {
  return React.createElement(
    LogActionsContext.Provider,
    { value },
    React.createElement(LogStateContext.Provider, { value }, ui),
  )
}

export function createJsonResponse(payload: unknown, status: number = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}
