import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeLogRecord } from '@/context/logUtils'
import { analyzeCurrentActivities } from '../currentActivity'
import { CurrentActivityEvidenceStrip } from '../CurrentActivityEvidenceStrip'
import { CurrentActivityStrip } from '../CurrentActivityStrip'

vi.mock('../currentActivity', async importOriginal => {
  const actual = await importOriginal<typeof import('../currentActivity')>()
  return { ...actual, analyzeCurrentActivities: vi.fn(actual.analyzeCurrentActivities) }
})

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('ticks elapsed time without rereading history and analyzes new evidence once', () => {
  vi.useFakeTimers()
  const startedAt = Date.now()
  const entries = [normalizeLogRecord({
    entryId: 'prompt', kind: 'prompt', source: 'model:provider/model', audience: 'ai',
    sessionId: 'ses_waiting', content: '[PROMPT] Work on this task.', timestamp: new Date(startedAt).toISOString(),
  }, 'CODING')]
  const view = render(<CurrentActivityStrip entries={entries} activeStatus="CODING" />)
  expect(analyzeCurrentActivities).toHaveBeenCalledTimes(1)
  act(() => { vi.advanceTimersByTime(3_000) })
  expect(screen.getByRole('status', { name: 'Current activity' })).toHaveTextContent('Waiting for first model activity')
  expect(screen.getByText('· 3s')).toBeInTheDocument()
  expect(analyzeCurrentActivities).toHaveBeenCalledTimes(1)
  view.rerender(<CurrentActivityStrip entries={[...entries]} activeStatus="CODING" />)
  expect(analyzeCurrentActivities).toHaveBeenCalledTimes(2)
})


it('applies a live successful result immediately while saved evidence is unchanged', () => {
  const record = (entryId: string, content: string, offset: number, kind = 'milestone') => normalizeLogRecord({
    entryId, kind, content, source: kind === 'prompt' ? 'model:provider/model' : 'system',
    audience: kind === 'prompt' ? 'ai' : 'all', sessionId: 'ses_live',
    timestamp: new Date(Date.now() + offset).toISOString(),
  }, 'CODING')
  const entries = [
    record('prompt', '[PROMPT] Work on this task.', -3_000, 'prompt'),
    record('empty', 'OpenCode coding_main: provider/model session=ses_live, messages=1, responseChars=0.', -2_000),
  ]
  const evidence = {
    entries, enabled: true, activeStatus: 'CODING', activePhaseAttempt: 1,
    error: undefined, errorTitle: null, retry: vi.fn(),
  }
  const view = render(<CurrentActivityEvidenceStrip evidence={evidence} liveEntries={[]} />)
  expect(screen.getByRole('status', { name: 'Current activity' })).toHaveTextContent('Model returned no response text')
  const result = record('success', 'OpenCode coding_main: provider/model session=ses_live, messages=2, responseChars=12.', -1_000)
  view.rerender(<CurrentActivityEvidenceStrip evidence={evidence} liveEntries={[result]} />)
  expect(screen.queryByRole('status', { name: 'Current activity' })).not.toBeInTheDocument()
})
