import { describe, expect, it } from 'vitest'
import { createStructuredCandidateFailureTracker } from '../failure'
import { normalizeInterviewDocumentOutput } from '../interviewDocument'

const isPromptEcho = (message: string) => /echoed the prompt/i.test(message)

describe('createStructuredCandidateFailureTracker', () => {
  it('returns the initial error when nothing was recorded', () => {
    const failure = createStructuredCandidateFailureTracker('nothing found').build('raw response')
    expect(failure.error).toBe('nothing found')
  })

  it('keeps the last candidate error and its diagnostic', () => {
    const failures = createStructuredCandidateFailureTracker('nothing found')
    failures.recordCandidateError('first candidate', new Error('first failed'), isPromptEcho)
    failures.recordCandidateError('second candidate', new Error('second failed'), isPromptEcho)

    const failure = failures.build('raw response')
    expect(failure.error).toBe('second failed')
    // The diagnostic quotes the candidate that failed, not the whole response.
    expect(failure.retryDiagnostic?.excerpt).toContain('second candidate')
  })

  it('prefers the first prompt echo over a later candidate error', () => {
    const failures = createStructuredCandidateFailureTracker('nothing found')
    failures.recordPromptEcho('echo candidate', 'output echoed the prompt')
    failures.recordCandidateError('second candidate', new Error('second failed'), isPromptEcho)

    expect(failures.build('raw response').error).toBe('output echoed the prompt')
  })

  it('keeps the first echo when a candidate error is itself an echo', () => {
    const failures = createStructuredCandidateFailureTracker('nothing found')
    failures.recordCandidateError('first', new Error('first echoed the prompt'), isPromptEcho)
    failures.recordCandidateError('second', new Error('second echoed the prompt'), isPromptEcho)

    expect(failures.build('raw response').error).toBe('first echoed the prompt')
  })

  it('uses the fallback error only when no echo was preferred', () => {
    const withEcho = createStructuredCandidateFailureTracker('nothing found')
    withEcho.recordPromptEcho('echo candidate', 'output echoed the prompt')
    expect(withEcho.build('raw', { fallbackError: 'fallback' }).error).toBe('output echoed the prompt')

    const withoutEcho = createStructuredCandidateFailureTracker('nothing found')
    withoutEcho.recordCandidateError('c', new Error('failed'), isPromptEcho)
    expect(withoutEcho.build('raw', { fallbackError: 'fallback' }).error).toBe('fallback')
  })
})

describe('interview document failures carry a diagnostic', () => {
  it('quotes the failing candidate rather than dropping the diagnostic', () => {
    // `lastRetryDiagnostic` was declared and read but never assigned.
    const result = normalizeInterviewDocumentOutput('questions: []', { ticketId: 'TEST-1' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryDiagnostic).toBeDefined()
    expect(result.retryDiagnostic?.validationError).toBe(result.error)
  })
})
