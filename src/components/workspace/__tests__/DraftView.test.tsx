import { useEffect } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>, projects: unknown[] = [projectData]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input)
    if (url === '/api/projects') return createJsonResponse(projects)
    if (url === '/api/profile') return createJsonResponse(profileData)
    if (url.startsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/logs?`)) {
      return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
    }
    return handler(url, init as RequestInit | undefined)
  })
}

const requireElement = (element: Element | null | undefined, description: string) => {
  expect(element).toBeInstanceOf(HTMLElement)
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${description}.`)
  return element
}

const waitTicket = makeTicket({
  availableActions: ['start', 'cancel'],
  aiQuestionsOverride: true,
  aiQuestionWindowOverride: 300_000,
})
const ticketUrl = `/api/tickets/${encodeURIComponent(TEST.ticketId)}`

const renderEditableWait = async (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<DraftView ticket={waitTicket} />)
  expect(await screen.findByText('Current Council Members')).toBeInTheDocument()
  const advanced = screen.getByRole('button', { name: /Advanced/ })
  fireEvent.click(advanced)
  const input = screen.getByLabelText('AI question wait')
  await waitFor(() => expect(input).toBeEnabled())
  return { fetchMock, input, advanced, start: screen.getByRole('button', { name: /start ticket/i }) }
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

  it.each([false, null] as const)('shows Advanced settings and preserves disabled duration with AI questions override %s', async (aiQuestionsOverride) => {
    const ordinaryTicket = makeTicket({ availableActions: ['start', 'cancel'], aiQuestionsOverride, aiQuestionWindowOverride: 900_000 })
    const fetchMock = mockFetch((url, init) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}` && init?.method === 'PATCH') {
        return createJsonResponse({ ...ordinaryTicket, ...JSON.parse(String(init.body)) })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    }, [{ ...projectData, aiQuestionsOverride: false }])
    renderWithProviders(<DraftView ticket={ordinaryTicket} />)

    expect(await screen.findByText('Current Council Members')).toBeInTheDocument()
    const advancedButton = screen.getByRole('button', { name: /Advanced/ })
    expect(advancedButton.parentElement).toHaveClass('border-2')
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Manual QA checkpoint')).not.toBeVisible()
    expect(screen.getByText('AI questions')).not.toBeVisible()
    expect(screen.getByText('AI question wait')).not.toBeVisible()

    fireEvent.click(advancedButton)
    expect(advancedButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Manual QA checkpoint')).toBeInTheDocument()
    const manualQa = within(screen.getByRole('radiogroup', { name: 'Manual QA setting' }))
    expect(manualQa.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Effective setting:/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open documentation for ticket Manual QA checkpoint' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    expect(screen.queryByText('Git hook policy')).not.toBeInTheDocument()
    const advanced = within(requireElement(advancedButton.parentElement, 'draft Advanced section'))
    expect(advanced.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#ai-questions`,
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#ai-question-wait`,
    ])
    expect(advanced.getByRole('link', { name: /ticket AI questions/i }).parentElement).toHaveTextContent('AI questions')
    expect(advanced.getByRole('link', { name: /ticket AI question wait/i }).parentElement).toHaveTextContent('AI question wait')
    const waitRow = advanced.getByText('AI question wait').closest('.pl-4')
    expect(waitRow).toHaveClass('pl-4')
    expect(waitRow).not.toHaveClass('border-t')
    expect(waitRow?.previousElementSibling).toContainElement(advanced.getByRole('radiogroup', { name: 'AI questions setting' }))

    const wait = screen.getByLabelText('AI question wait')
    const modes = within(screen.getByRole('radiogroup', { name: 'AI question wait source' })).getAllByRole('radio')
    await waitFor(() => expect(wait).toBeDisabled())
    for (const mode of modes) expect(mode).toBeDisabled()
    expect(wait).toHaveValue(15)
    expect(screen.getByRole('radio', { name: /Set a custom ai question wait/i })).toHaveAttribute('aria-checked', 'true')

    const questions = within(screen.getByRole('radiogroup', { name: 'AI questions setting' }))
    fireEvent.click(questions.getByRole('radio', { name: 'On' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tickets/${encodeURIComponent(TEST.ticketId)}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ aiQuestionsOverride: true }) }),
    ))
    for (const mode of modes) expect(mode).toBeEnabled()
    expect(wait).toBeEnabled()
    expect(wait).toHaveValue(15)
    expect(screen.getByRole('radio', { name: /Set a custom ai question wait/i })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(questions.getByRole('radio', { name: 'Inherit' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tickets/${encodeURIComponent(TEST.ticketId)}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ aiQuestionsOverride: null }) }),
    ))
    for (const mode of modes) expect(mode).toBeDisabled()
    expect(wait).toBeDisabled()
    expect(wait).toHaveValue(15)

    fireEvent.click(advancedButton)
    expect(screen.getByText('AI questions')).not.toBeVisible()
    expect(screen.getByText('AI question wait')).not.toBeVisible()
  })

  it('preserves an invalid wait and explains blocked Start while Advanced is collapsed', async () => {
    const { input, advanced, start, fetchMock } = await renderEditableWait((url) => {
      throw new Error(`Unexpected request while the wait is invalid: ${url}`)
    })
    fireEvent.change(input, { target: { value: '61' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(start).toBeDisabled()

    fireEvent.click(advanced)
    expect(input).not.toBeVisible()
    expect(input).toHaveValue(61)
    expect(screen.getByText('Fix AI question wait in Advanced.')).toBeVisible()
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(fetchMock).not.toHaveBeenCalledWith(`${ticketUrl}/start`, expect.anything())
    expect(fetchMock).not.toHaveBeenCalledWith(ticketUrl, expect.objectContaining({ method: 'PATCH' }))

    fireEvent.click(advanced)
    expect(input).toBeVisible()
    expect(input).toHaveValue(61)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Fix AI question wait in Advanced.')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '12' } })
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it.each([
    { commit: 'blur', finish: (input: HTMLElement) => fireEvent.blur(input) },
    { commit: 'Enter', finish: (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Enter' }) },
  ])('saves only the completed draft wait on $commit and keeps controls usable while saving', async ({ finish }) => {
    const saved = createDeferredJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 1_800_000 })
    const { input, start, fetchMock } = await renderEditableWait((url, init) => {
      if (url === ticketUrl && init?.method === 'PATCH') return saved.promise
      throw new Error(`Unhandled fetch: ${url}`)
    })
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.change(input, { target: { value: '30' } })
    expect(input).toHaveValue(30)
    expect(fetchMock).not.toHaveBeenCalledWith(ticketUrl, expect.objectContaining({ method: 'PATCH' }))

    finish(input)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ aiQuestionWindowOverride: 1_800_000 }),
    })))
    expect(fetchMock).not.toHaveBeenCalledWith(ticketUrl, expect.objectContaining({
      body: JSON.stringify({ aiQuestionWindowOverride: 180_000 }),
    }))
    expect(start).toBeEnabled()
    expect(input).toBeEnabled()

    await act(async () => { saved.resolve() })
    await waitFor(() => expect(start).toBeEnabled())
    expect(input).toBeEnabled()
    expect(input).toHaveValue(30)
    fireEvent.blur(input)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  })

  it('queues Start while another Advanced setting is saving', async () => {
    const saved = createDeferredJsonResponse({ ...waitTicket, manualQaOverride: false })
    const { start, fetchMock } = await renderEditableWait((url, init) => {
      if (url === ticketUrl && init?.method === 'PATCH') return saved.promise
      if (url === `${ticketUrl}/start`) return createJsonResponse({ message: 'Ticket started.' })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const manualQa = within(screen.getByRole('radiogroup', { name: 'Manual QA setting' }))
    fireEvent.click(manualQa.getByRole('radio', { name: 'Disabled' }))
    expect(start).toBeEnabled()
    fireEvent.click(start)
    expect(fetchMock).not.toHaveBeenCalledWith(`${ticketUrl}/start`, expect.anything())

    await act(async () => { saved.resolve() })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${ticketUrl}/start`, expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(start).toBeEnabled())
  })

  it('saves on native blur before a Start click and waits for that save to finish', async () => {
    const saved = createDeferredJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 1_800_000 })
    const { input, start, fetchMock } = await renderEditableWait((url, init) => {
      if (url === ticketUrl && init?.method === 'PATCH') return saved.promise
      if (url === `${ticketUrl}/start`) return createJsonResponse({ message: 'Ticket started.' })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    fireEvent.change(input, { target: { value: '30' } })

    await act(async () => {
      input.focus()
      start.focus()
      start.click()
    })

    expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ aiQuestionWindowOverride: 1_800_000 }),
    }))
    expect(fetchMock).not.toHaveBeenCalledWith(`${ticketUrl}/start`, expect.anything())
    await waitFor(() => expect(start).toBeDisabled())

    await act(async () => { saved.resolve() })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${ticketUrl}/start`, expect.objectContaining({ method: 'POST' })))
  })

  it.each([
    { group: 'Manual QA setting', choice: 'Disabled', payload: { manualQaOverride: false } },
    { group: 'AI questions setting', choice: 'Off', payload: { aiQuestionsOverride: false } },
    { group: 'AI question wait source', choice: /Inherit AI question wait/i, payload: { aiQuestionWindowOverride: null } },
  ])('keeps a native blur-to-$group click and saves it after the wait', async ({ group, choice, payload }) => {
    const saved = createDeferredJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 1_800_000 })
    const { input, fetchMock } = await renderEditableWait((url, init) => {
      if (url !== ticketUrl || init?.method !== 'PATCH') throw new Error(`Unhandled fetch: ${url}`)
      const patch = JSON.parse(String(init.body))
      return patch.aiQuestionWindowOverride === 1_800_000
        ? saved.promise
        : createJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 1_800_000, ...patch })
    })
    const option = within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: choice })
    fireEvent.change(input, { target: { value: '30' } })
    await act(async () => { input.focus(); option.focus(); option.click() })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    expect(option).toHaveAttribute('aria-checked', 'true')

    await act(async () => { saved.resolve() })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify(payload),
    })))
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2)
    expect(option).toHaveAttribute('aria-checked', 'true')
  })

  it('queues description Save after a wait edit', async () => {
    const saved = createDeferredJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 1_800_000 })
    const description = 'Keep this edited description.'
    const { input, fetchMock } = await renderEditableWait((url, init) => {
      if (url !== ticketUrl || init?.method !== 'PATCH') throw new Error(`Unhandled fetch: ${url}`)
      const patch = JSON.parse(String(init.body))
      return patch.description ? createJsonResponse({ ...waitTicket, description }) : saved.promise
    })
    fireEvent.click(screen.getByRole('button', { name: /(Edit|Add) Description/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Ticket description' }), { target: { value: description } })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.change(input, { target: { value: '30' } })
    await act(async () => { input.focus(); save.focus(); save.click() })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    await act(async () => { saved.resolve() })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.objectContaining({ body: JSON.stringify({ description }) })))
    expect(await screen.findByText(description)).toBeInTheDocument()
  })

  it.each(['Start', 'AI questions', 'description Save'])('stops queued %s when the preceding wait save fails', async (activation) => {
    const saved = createDeferredJsonResponse({ error: 'Wait save failed.' }, 400)
    const { input, start, fetchMock } = await renderEditableWait((url) => {
      if (url === ticketUrl) return saved.promise
      throw new Error(`Queued action must not run: ${url}`)
    })
    if (activation === 'description Save') {
      fireEvent.click(screen.getByRole('button', { name: /(Edit|Add) Description/i }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Ticket description' }), { target: { value: 'Unsaved description.' } })
    }
    const target = activation === 'Start' ? start : activation === 'AI questions'
      ? within(screen.getByRole('radiogroup', { name: 'AI questions setting' })).getByRole('radio', { name: 'Off' })
      : screen.getByRole('button', { name: 'Save' })
    fireEvent.change(input, { target: { value: '30' } })
    await act(async () => { input.focus(); target.focus(); target.click() })
    await act(async () => { saved.resolve() })
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Wait save failed.'))).toBe(true))
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalledWith(`${ticketUrl}/start`, expect.anything())
    expect(input).toHaveValue(5)
    if (activation === 'AI questions') expect(target).toHaveAttribute('aria-checked', 'false')
    if (activation === 'description Save') expect(screen.getByRole('textbox', { name: 'Ticket description' })).toHaveValue('Unsaved description.')
  })

  it('keeps radio focus during a pending keyboard save and ignores a selected option', async () => {
    const saved = createDeferredJsonResponse({ ...waitTicket, manualQaOverride: false })
    const { fetchMock } = await renderEditableWait((url) => {
      if (url === ticketUrl) return saved.promise
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const group = within(screen.getByRole('radiogroup', { name: 'Manual QA setting' }))
    const selected = group.getByRole('radio', { name: 'Enabled' })
    await act(() => selected.focus())
    fireEvent.keyDown(selected, { key: 'ArrowRight' })
    const next = group.getByRole('radio', { name: 'Disabled' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.anything()))
    expect(next).toBeEnabled()
    expect(next).toHaveFocus()
    fireEvent.click(next)
    await act(async () => { saved.resolve() })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  })

  it('keeps a later wait edit during saving and rolls back to the last successful value', async () => {
    const first = createDeferredJsonResponse({ ...waitTicket, aiQuestionWindowOverride: 900_000 })
    const second = createDeferredJsonResponse({ error: 'Second wait save failed.' }, 400)
    const { input, fetchMock } = await renderEditableWait((url, init) => {
      if (url !== ticketUrl) throw new Error(`Unhandled fetch: ${url}`)
      return JSON.parse(String(init?.body)).aiQuestionWindowOverride === 900_000 ? first.promise : second.promise
    })
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1))
    await act(async () => { first.resolve() })
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2))
    expect(input).toHaveValue(30)
    await act(async () => { second.resolve() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Second wait save failed.')
    expect(input).toHaveValue(15)
  })

  it('shows a failed wait save after native blur collapses Advanced', async () => {
    const saved = createDeferredJsonResponse({ error: 'Collapsed wait save failed.' }, 400)
    const { input, advanced } = await renderEditableWait((url) => {
      if (url === ticketUrl) return saved.promise
      throw new Error(`Unhandled fetch: ${url}`)
    })
    fireEvent.change(input, { target: { value: '30' } })
    await act(async () => { input.focus(); advanced.focus(); advanced.click() })
    await act(async () => { saved.resolve() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Collapsed wait save failed.')
    expect(screen.getByRole('alert')).toBeVisible()
    expect(input).not.toBeVisible()
  })

  it('locks Advanced edits during Start and unlocks them after a failed start', async () => {
    const started = createDeferredJsonResponse({ error: 'Start rejected.' }, 400)
    const { input, start, fetchMock } = await renderEditableWait((url) => {
      if (url === `${ticketUrl}/start`) return started.promise
      throw new Error(`Unhandled fetch: ${url}`)
    })
    fireEvent.click(start)
    await waitFor(() => expect(input).toBeDisabled())
    const radios = screen.getAllByRole('radio')
    for (const radio of radios) expect(radio).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /Inherit AI question wait/i }))
    expect(fetchMock).not.toHaveBeenCalledWith(ticketUrl, expect.objectContaining({ method: 'PATCH' }))

    await act(async () => { started.resolve() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Start rejected.')
    await waitFor(() => expect(input).toBeEnabled())
    for (const radio of radios) expect(radio).toBeEnabled()
    expect(input).toHaveValue(5)
  })

  it('restores the saved wait and re-enables Start when a completed wait update fails', async () => {
    const { input, start, fetchMock } = await renderEditableWait((url, init) => {
      if (url === ticketUrl && init?.method === 'PATCH') {
        return createJsonResponse({ error: 'AI question wait update rejected.' }, 400)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)

    expect(await screen.findByText(/AI question wait update rejected\./)).toBeInTheDocument()
    await waitFor(() => expect(input).toHaveValue(5))
    expect(input).toBeEnabled()
    expect(start).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith(ticketUrl, expect.objectContaining({
      body: JSON.stringify({ aiQuestionWindowOverride: 1_800_000 }),
    }))
  })

  it('mounts the draft log viewer immediately when start begins and keeps it open on failure', async () => {
    const startResponse = createDeferredJsonResponse({
      error: 'Council member models are not configured in OpenCode: anthropic/claude-sonnet-4, google/gemini-2.5-pro',
    }, 400)

    mockFetch((url) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/start`) {
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

    const start = screen.getByRole('button', { name: /start ticket/i })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)

    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()
    expect(await screen.findByText(/No log entries yet\. Logs will stream here during execution\./i)).toBeInTheDocument()

    startResponse.resolve()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Council member models are not configured in OpenCode')
    expect(alert).toHaveTextContent('Update Configuration to choose currently available models, then try again.')
    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()
  })

  it('keeps the draft log viewer open after a successful start', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/start`) {
        return createJsonResponse({ message: 'Ticket started.', ticketId: TEST.ticketId })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<DraftView ticket={makeTicket({ availableActions: ['start', 'cancel'] })} />)

    const start = await screen.findByRole('button', { name: /start ticket/i })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)

    expect(await screen.findByText(/No log entries yet\. Logs will stream here during execution\./i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /start ticket/i })).toBeEnabled())
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/start`, expect.objectContaining({ method: 'POST' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders streamed draft logs through LogProvider once the start viewer is open', async () => {
    const startResponse = createDeferredJsonResponse({ error: 'Failed to start ticket.' }, 400)

    mockFetch((url) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/start`) {
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

    const start = screen.getByRole('button', { name: /start ticket/i })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)

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
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}` && init?.method === 'PATCH') {
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

    const { rerender } = renderWithProviders(<DraftView ticket={makeTicket({ description: 'Add a planning gate before interview.', availableActions: ['start', 'cancel'] })} />)

    fireEvent.click(screen.getByRole('button', { name: /edit description/i }))

    const textarea = screen.getByRole('textbox', { name: 'Ticket description' })
    expect(textarea).toHaveValue('Add a planning gate before interview.')

    fireEvent.change(textarea, { target: { value: updatedDescription } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByText(updatedDescription)).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Ticket description' })).not.toBeInTheDocument()
    })
    rerender(<DraftView ticket={makeTicket({ description: updatedDescription, availableActions: ['start', 'cancel'] })} />)
    expect(await screen.findByText(updatedDescription)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}`, expect.objectContaining({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: updatedDescription }),
    }))
  })

  it('cancels description edits and syncs later ticket description updates', async () => {
    const initialDescription = 'Keep the original draft context.'
    const externalDescription = 'A collaborator updated this draft description.'
    const { rerender } = renderWithProviders(<DraftView ticket={makeTicket({ description: initialDescription })} />)

    fireEvent.click(await screen.findByRole('button', { name: /edit description/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Ticket description' }), {
      target: { value: 'Unsaved local change.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText(initialDescription)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'true')

    rerender(<DraftView ticket={makeTicket({ description: externalDescription })} />)

    expect(await screen.findByText(externalDescription)).toBeInTheDocument()
  })

  it('keeps description editing open and shows the server error when saving fails', async () => {
    mockFetch((url, init) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}` && init?.method === 'PATCH') {
        return createJsonResponse({ error: 'Description update rejected.' }, 400)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<DraftView ticket={makeTicket({ description: 'Original description.' })} />)

    fireEvent.click(await screen.findByRole('button', { name: /edit description/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Ticket description' }), {
      target: { value: 'A new description.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Description update rejected.')
    expect(screen.getByRole('textbox', { name: 'Ticket description' })).toHaveValue('A new description.')
  })

  it.each([
    { setting: 'Manual QA', group: /Manual QA setting/i, choice: 'Disabled', selected: 'Enabled', payload: { manualQaOverride: false } },
    { setting: 'AI questions', group: /AI questions setting/i, choice: 'On', selected: 'Inherit', payload: { aiQuestionsOverride: true } },
    { setting: 'AI question wait', group: /AI question wait source/i, choice: /Set a custom ai question wait/i, selected: /Inherit ai question wait/i, payload: { aiQuestionWindowOverride: 300_000 } },
  ])('restores draft $setting selections when their ticket updates fail', async ({ setting, group, choice, selected, payload }) => {
    const fetchMock = mockFetch((url, init) => {
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}`) {
        expect(JSON.parse(String(init?.body))).toEqual(payload)
        return createJsonResponse({ error: `${setting} update rejected.` }, 400)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(<DraftView ticket={makeTicket({ manualQaOverride: true })} />)
    fireEvent.click(await screen.findByRole('button', { name: /Advanced/ }))

    const controls = within(screen.getByRole('radiogroup', { name: group }))
    const option = controls.getByRole('radio', { name: choice })
    await waitFor(() => expect(option).toBeEnabled())
    fireEvent.click(option)
    expect(await screen.findByRole('alert')).toHaveTextContent(`${setting} update rejected.`)
    const restored = controls.getByRole('radio', { name: selected })
    expect(restored).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(restored)
    expect(screen.getByRole('alert')).toHaveTextContent(`${setting} update rejected.`)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  })

  it('falls back to the main implementer when project council JSON is malformed', async () => {
    mockFetch((url) => {
      throw new Error(`Unhandled fetch: ${url}`)
    }, [{ ...projectData, councilMembers: '{invalid-json' }])

    renderWithProviders(<DraftView ticket={makeTicket()} />)

    expect(await screen.findByText('Current Council Members')).toBeInTheDocument()
    expect(screen.getByText('openai/codex-mini-latest')).toBeInTheDocument()
    expect(screen.queryByText('openai/gpt-5.3-codex')).not.toBeInTheDocument()
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
