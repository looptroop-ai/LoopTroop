import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeLogRecord, type LogEntry } from '@/context/logUtils'
import { makeTicket } from '@/test/factories'
import { createJsonResponse, renderWithProviders } from '@/test/renderHelpers'
import { FullLogView } from '../FullLogView'
import { PhaseLogPanel } from '../PhaseLogPanel'

const live = vi.hoisted(() => ({ entries: [] as LogEntry[] }))
const readLogs = () => live.entries
vi.mock('@/context/useLogContext', () => ({
  useLogs: () => ({ getAllLogs: readLogs, getLogsForPhase: readLogs }),
}))

const models = ['provider/model-a', 'provider/model-b']
const page = (modelIds = models, content = 'Overview history.') => ({
  entries: [{ phase: 'CODING', entryId: content, content }],
  modelIds, olderCursor: null, hasOlder: false,
})
const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  live.entries = []
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'clipboard') })

describe.each(['phase', 'lifecycle'] as const)('%s history selection', scope => {
  function panel(changed = false) {
    const ticket = makeTicket({ status: 'CODING', id: scope === 'lifecycle' && changed ? 'second-ticket' : 'first-ticket' })
    return scope === 'phase'
      ? <PhaseLogPanel phase="CODING" phaseAttempt={changed ? 2 : 1} ticket={ticket} />
      : <FullLogView ticket={ticket} />
  }

  it.each([200, 503])('keeps selection and exports aligned through loading and a scope response with status %i', async status => {
    let resolveModel!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.includes('/logs/export')) return Promise.resolve(new Response('Selected model history.'))
      if (url.pathname.includes('/second-ticket/') || url.searchParams.get('phaseAttempt') === '2') return createJsonResponse(page([], 'New scope overview.'), status)
      if (url.searchParams.has('modelId')) return new Promise(resolve => { resolveModel = resolve })
      return createJsonResponse(page())
    })
    const view = renderWithProviders(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByTitle(/^provider\/model-a ·/))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(screen.getByTitle(/^provider\/model-a ·/)).toHaveClass('bg-primary')
    expect(screen.getByTitle(/^provider\/model-b ·/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy all logs' })).toBeDisabled()
    await act(async () => resolveModel(await createJsonResponse({ ...page(), entries: [{
      phase: 'CODING', entryId: 'answer', content: 'Historical model answer.', source: `model:${models[0]}`, audience: 'ai', kind: 'text',
    }] })))
    expect(await screen.findByText('Historical model answer.')).toBeInTheDocument()
    expect(screen.getByTitle(/^provider\/model-b ·/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy all logs' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Selected model history.'))
    const exported = new URL(String(fetchSpy.mock.lastCall![0]), 'http://localhost')
    expect(exported.searchParams.get('modelId')).toBe(models[0])
    expect(exported.searchParams.get('view')).toBe('ai')
    view.rerender(panel(true))
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0))
    if (status === 200) expect(screen.getByText('New scope overview.')).toBeInTheDocument()
    const next = new URL(String(fetchSpy.mock.lastCall![0]), 'http://localhost')
    expect(next.searchParams.get('view')).toBe('overview')
    expect(next.searchParams.has('modelId')).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Copy all logs' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    const finalExport = new URL(String(fetchSpy.mock.lastCall![0]), 'http://localhost')
    expect(finalExport.searchParams.get('view')).toBe('overview')
    expect(finalExport.searchParams.has('modelId')).toBe(false)
  })

  it('keeps a live-only model selected when history metadata does not contain it and the narrowed request fails', async () => {
    live.entries = [normalizeLogRecord({ entryId: 'live', source: 'model:provider/live', content: 'Live answer.', audience: 'ai', kind: 'text' }, 'CODING')]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.includes('/logs/export')) return Promise.resolve(new Response('Live model export.'))
      return url.searchParams.has('modelId') ? createJsonResponse({ error: 'Unavailable' }, 503) : createJsonResponse(page())
    })
    renderWithProviders(panel())
    await screen.findByText('Overview history.')
    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByTitle(/^provider\/live ·/))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(screen.getByTitle(/^provider\/live ·/)).toHaveClass('bg-primary')
    expect(screen.getByText('Live answer.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy all logs' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Live model export.'))
    expect(new URL(String(fetchSpy.mock.lastCall![0]), 'http://localhost').searchParams.get('modelId')).toBe('provider/live')
  })

  it('retracts prior success on export failure, announces each retry, and ignores an export from a previous filter', async () => {
    let exports = 0
    let resolveOld!: (response: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      if (!String(input).includes('/logs/export')) return createJsonResponse(page())
      exports += 1
      if (exports === 1) return Promise.resolve(new Response('First export.'))
      if (exports < 4) return createJsonResponse({ error: 'Export refused' }, 503)
      return new Promise(resolve => { resolveOld = resolve })
    })
    renderWithProviders(panel())
    await screen.findByText('Overview history.')
    const copy = screen.getByRole('button', { name: 'Copy all logs' })
    fireEvent.click(copy)
    await waitFor(() => expect(copy.querySelector('.lucide-check')).toBeInTheDocument())
    fireEvent.click(copy)
    const first = await screen.findByRole('alert')
    expect(copy.querySelector('.lucide-check')).not.toBeInTheDocument()
    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('alert')).not.toBe(first))
    fireEvent.click(copy)
    expect(copy).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))
    await waitFor(() => expect(copy).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => resolveOld(new Response('Wrong old filter.')))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copy.querySelector('.lucide-check')).not.toBeInTheDocument()
  })
})
