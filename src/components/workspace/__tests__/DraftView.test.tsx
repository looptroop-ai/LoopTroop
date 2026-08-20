import { useEffect } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTicket, TEST } from '@/test/factories'
import { createJsonResponse, createTestQueryClient, renderWithProviders as sharedRenderWithProviders } from '@/test/renderHelpers'
import { LogProvider } from '@/context/LogContext'
import { useLogs } from '@/context/useLogContext'
import { DraftView } from '../DraftView'

const queryClients: QueryClient[] = []
let latestLogApi: ReturnType<typeof useLogs> = null

function createDeferredJsonResponse(payload: unknown, status: number = 200) {
  let resolveResponse: ((value: Response) => void) | null = null
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve
  })

  return {
    promise,
    resolve: () => resolveResponse?.(new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })),
  }
}

function hasTextContent(text: string) {
  return (_content: string, node: Element | null) => node?.textContent?.includes(text) ?? false
}

function DraftLogHarness() {
  const logApi = useLogs()

  useEffect(() => {
    latestLogApi = logApi
  }, [logApi])

  return null
}

function renderWithProviders(
  ui: React.ReactElement,
  options?: { withLogProvider?: boolean; logProviderTicketId?: string | null },
) {
  const queryClient = createTestQueryClient()
  queryClients.push(queryClient)

  const wrapped = options?.withLogProvider
    ? (
      <LogProvider ticketId={options.logProviderTicketId} currentStatus="DRAFT">
        {ui}
      </LogProvider>
    )
    : ui

  return sharedRenderWithProviders(wrapped, { queryClient })
}

const projectData = {
  id: TEST.projectId,
  name: 'looptroop',
  shortname: 'LOOP',
  icon: '🍂',
  color: '#a855f7',
  folderPath: '/mnt/d/TestLoopTroop',
  profileId: null,
  councilMembers: null,
  maxIterations: null,
  perIterationTimeout: null,
  councilResponseTimeout: null,
  minCouncilQuorum: null,
  interviewQuestions: null,
  gitHookPolicy: 'observe_only',
  ticketCounter: 1,
  createdAt: '2026-03-13T15:47:26.973Z',
  updatedAt: '2026-03-13T15:47:26.973Z',
}

const profileData = {
  id: 1,
  mainImplementer: 'openai/codex-mini-latest',
  councilMembers: JSON.stringify([
    'openai/codex-mini-latest',
    'openai/gpt-5.3-codex',
    'anthropic/claude-sonnet-4',
  ]),
  minCouncilQuorum: 2,
  perIterationTimeout: 300000,
  councilResponseTimeout: 300000,
  interviewQuestions: 50,
  maxIterations: 5,
  gitHookPolicy: 'validate_advisory',
  createdAt: '2026-03-13T15:47:26.973Z',
  updatedAt: '2026-03-13T15:47:26.973Z',
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input)
    if (url === '/api/projects') return createJsonResponse([projectData])
    if (url === '/api/profile') return createJsonResponse(profileData)
    if (url.startsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/logs?`)) {
      return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
    }
    return handler(url, init as RequestInit | undefined)
  })
}

describe('DraftView', () => {
  afterEach(() => {
    cleanup()
    latestLogApi = null
    for (const queryClient of queryClients.splice(0)) {
      queryClient.clear()
    }
    vi.restoreAllMocks()
  })

  it('shows only Manual QA inside the collapsed Advanced section for ordinary Draft tickets', async () => {
    const ordinaryTicket = makeTicket({ availableActions: ['start', 'cancel'] })
    renderWithProviders(<DraftView ticket={ordinaryTicket} />)

    expect(await screen.findByText('Current Council Members')).toBeInTheDocument()
    const advancedButton = screen.getByRole('button', { name: /Advanced/ })
    expect(advancedButton.parentElement).toHaveClass('border-2')
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Manual QA checkpoint')).not.toBeInTheDocument()

    fireEvent.click(advancedButton)
    expect(advancedButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Manual QA checkpoint')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Effective setting:/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open documentation for ticket Manual QA checkpoint' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    expect(screen.queryByText('Git hook policy')).not.toBeInTheDocument()
  })

  it('mounts the draft log viewer immediately when start begins and keeps it open on failure', async () => {
    const startResponse = createDeferredJsonResponse({
      error: 'Council member models are not configured in OpenCode: anthropic/claude-sonnet-4, google/gemini-2.5-pro',
    }, 400)

    mockFetch((url) => {
      if (url === `/api/tickets/${TEST.ticketId}/start`) {
        return startResponse.promise
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<DraftView ticket={makeTicket({ description: 'Add a planning gate before interview.', availableActions: ['start', 'cancel'] })} />)

    expect(await screen.findByText('Current Council Members')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Council member info' })).toBeInTheDocument()
    expect(screen.getByText('Main Implementer')).toBeInTheDocument()
    expect(screen.getByText('openai/codex-mini-latest')).toBeInTheDocument()
    expect(screen.getByText('openai/gpt-5.3-codex')).toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-sonnet-4')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /start ticket/i }))

    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()
    expect(await screen.findByText(/No log entries yet\. Logs will stream here during execution\./i)).toBeInTheDocument()

    startResponse.resolve()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Council member models are not configured in OpenCode')
    expect(alert).toHaveTextContent('Update Configuration to choose currently available models, then try again.')
    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()
  })

  it('renders streamed draft logs through LogProvider once the start viewer is open', async () => {
    const startResponse = createDeferredJsonResponse({ error: 'Failed to start ticket.' }, 400)

    mockFetch((url) => {
      if (url === `/api/tickets/${TEST.ticketId}/start`) {
        return startResponse.promise
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <>
        <DraftView ticket={makeTicket({ description: 'Add a planning gate before interview.', availableActions: ['start', 'cancel'] })} />
        <DraftLogHarness />
      </>,
      {
        withLogProvider: true,
        logProviderTicketId: null,
      },
    )

    expect(await screen.findByText('Current Council Members')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /start ticket/i }))

    expect(await screen.findByText(/No log entries yet\. Logs will stream here during execution\./i)).toBeInTheDocument()

    await waitFor(() => {
      expect(latestLogApi).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        latestLogApi?.addLog('DRAFT', 'Validating model availability.', {
          source: 'system',
          kind: 'milestone',
        })
        await vi.advanceTimersByTimeAsync(250)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(screen.getAllByText(hasTextContent('Validating model availability.')).length).toBeGreaterThan(0)

    startResponse.resolve()
    await screen.findByRole('alert')
  })

  it('lets users edit the description while the ticket is in backlog', async () => {
    const updatedDescription = 'Add a planning gate before interview and let users adjust the description before start.'
    const fetchMock = mockFetch((url, init) => {
      if (url === `/api/tickets/${TEST.ticketId}` && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ description: updatedDescription }))
        return createJsonResponse({
          ...makeTicket(),
          description: updatedDescription,
          updatedAt: '2026-03-13T16:00:00.000Z',
        })
      }

      // Handle query invalidation refetches after PATCH
      if (url.startsWith('/api/tickets')) {
        return createJsonResponse([{ ...makeTicket(), description: updatedDescription }])
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<DraftView ticket={makeTicket({ description: 'Add a planning gate before interview.', availableActions: ['start', 'cancel'] })} />)

    fireEvent.click(screen.getByRole('button', { name: /edit description/i }))

    const textarea = screen.getByRole('textbox', { name: 'Ticket description' })
    expect(textarea).toHaveValue('Add a planning gate before interview.')

    fireEvent.change(textarea, { target: { value: updatedDescription } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByText(updatedDescription)).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Ticket description' })).not.toBeInTheDocument()
    })
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${TEST.ticketId}`, expect.objectContaining({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: updatedDescription }),
    }))
  })

  it('previews Markdown descriptions and switches back to the raw source', () => {
    renderWithProviders(<DraftView ticket={makeTicket({ description: '# Scope\nUse **bold** details.', availableActions: ['start', 'cancel'] })} />)

    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByRole('button', { name: 'Copy description' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }))

    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Copy description' })).toBeInTheDocument()
    expect(screen.getByText((_content, element) =>
      element?.tagName === 'P' && element.textContent === '# Scope\nUse **bold** details.',
    )).toBeInTheDocument()
  })
})
