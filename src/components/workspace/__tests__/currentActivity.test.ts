import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@/context/LogContext'
import { normalizeLogRecord } from '@/context/logUtils'
import { deriveCurrentActivity, deriveCurrentActivities, formatElapsedDuration } from '../currentActivity'

const BASE_TIME_MS = Date.parse('2026-05-25T10:00:00.000Z')

function timestamp(offsetMs: number): string {
  return new Date(BASE_TIME_MS + offsetMs).toISOString()
}

function makeLog(id: string, line: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    entryId: id,
    line,
    source: 'system',
    status: 'CODING',
    timestamp: timestamp(0),
    audience: 'all',
    kind: 'milestone',
    streaming: false,
    op: 'append',
    ...overrides,
  }
}

function makePrompt(overrides: Partial<LogEntry> = {}): LogEntry {
  return makeLog('prompt-1', '[PROMPT] openai/gpt-5-codex prompt #1\nImplement bead 2.', {
    source: 'model:openai/gpt-5-codex',
    audience: 'ai',
    kind: 'prompt',
    modelId: 'openai/gpt-5-codex',
    sessionId: 'ses_waiting',
    beadId: 'bead-2',
    ...overrides,
  })
}

describe('deriveCurrentActivity', () => {
  it('shows waiting elapsed time after a prompt with no later activity', () => {
    const activity = deriveCurrentActivity([makePrompt()], BASE_TIME_MS + 72_000)

    expect(activity?.kind).toBe('waiting_first_model_activity')
    expect(activity?.label).toBe('Waiting for first model activity')
    expect(activity?.elapsedMs).toBe(72_000)
    expect(formatElapsedDuration(activity?.elapsedMs ?? 0)).toBe('1m 12s')
    expect(activity?.sessionId).toBe('ses_waiting')
    expect(activity?.beadId).toBe('bead-2')
  })

  it('treats a continue please prompt as a normal model dispatch', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        id: 'continue-prompt',
        entryId: 'continue-prompt',
        line: '[PROMPT] openai/gpt-5-codex prompt #2\ncontinue please',
        sessionId: 'ses_continue',
      }),
    ], BASE_TIME_MS + 5_000)

    expect(activity?.kind).toBe('waiting_first_model_activity')
    expect(activity?.sessionId).toBe('ses_continue')
  })

  it('clears waiting after the first model activity milestone', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('first-activity', 'First AI activity observed from openai/gpt-5-codex (session=ses_waiting).', {
        timestamp: timestamp(2_000),
        source: 'model:openai/gpt-5-codex',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_waiting',
      }),
    ], BASE_TIME_MS + 10_000)

    expect(activity).toBeNull()
  })

  it('shows provider retrying after a session retry before first activity', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('retry-1', 'Session retry #1: The usage limit has been reached. Please try again later.', {
        timestamp: timestamp(3_000),
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'error',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_waiting',
      }),
    ], BASE_TIME_MS + 8_000)

    expect(activity?.kind).toBe('provider_retrying')
    expect(activity?.label).toBe('Provider retrying before first model activity')
    expect(activity?.active).toBe(true)
  })

  it('shows provider retry timeout when the OpenCode retry budget expires', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('retry-timeout', '[ERROR] OpenCode retry grace window expired after 60000ms (retry attempt 2): usage limit.', {
        timestamp: timestamp(60_000),
        source: 'error',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 61_000)

    expect(activity?.kind).toBe('provider_retry_timeout')
    expect(activity?.diagnostic).toBe('provider_retry_timeout')
    expect(activity?.active).toBe(false)
  })

  it('classifies explicit OpenCode provider timeout logs as provider_timeout_preserved', () => {
    const activity = deriveCurrentActivity([
      makePrompt({ sessionId: 'ses_continue' }),
      makeLog('provider-timeout', 'OpenCode/provider timeout for session ses_continue; preserving session for Continue.', {
        timestamp: timestamp(60_000),
        source: 'opencode',
        audience: 'debug',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 61_000)

    expect(activity?.kind).toBe('provider_timeout_preserved')
    expect(activity?.diagnostic).toBe('provider_timeout_preserved')
    expect(activity?.sessionId).toBe('ses_continue')
  })

  it('shows empty-output state for responseChars=0', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('empty-output', '[SYS] OpenCode coding_main: openai/gpt-5-codex session=ses_waiting, messages=3, responseChars=0.', {
        timestamp: timestamp(4_000),
        modelId: 'openai/gpt-5-codex',
      }),
    ], BASE_TIME_MS + 5_000)

    expect(activity?.kind).toBe('empty_model_output')
    expect(activity?.label).toBe('Model returned no response text')
    expect(activity?.diagnostic).toBe('empty_model_output')
  })

  it('classifies timeout before first activity as model_no_activity_timeout', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('timeout', '[ERROR] OpenCode prompt timed out after 120000ms.', {
        timestamp: timestamp(120_000),
        source: 'error',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 121_000)

    expect(activity?.kind).toBe('model_no_activity_timeout')
    expect(activity?.diagnostic).toBe('model_no_activity_timeout')
  })

  it('freezes terminal timeout elapsed duration at the diagnostic timestamp', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('timeout', '[ERROR] OpenCode prompt timed out after 120000ms.', {
        timestamp: timestamp(120_000),
        source: 'error',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 600_000)

    expect(activity?.kind).toBe('model_no_activity_timeout')
    expect(activity?.elapsedMs).toBe(120_000)
  })

  it('classifies explicit iteration timeout logs as iteration_timeout', () => {
    const activity = deriveCurrentActivity([
      makePrompt({ sessionId: 'ses_iteration', beadId: 'bead-7' }),
      makeLog('iteration-timeout', 'Iteration timeout for bead bead-7 attempt 1; resetting for attempt 2 of 3.', {
        timestamp: timestamp(120_000),
        source: 'workflow',
        audience: 'debug',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 121_000)

    expect(activity?.kind).toBe('iteration_timeout')
    expect(activity?.diagnostic).toBe('iteration_timeout')
    expect(activity?.beadId).toBe('bead-7')
  })

  it('classifies timeout after first activity as workflow_timeout', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('model-output', '[MODEL] Starting implementation.', {
        timestamp: timestamp(2_000),
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_waiting',
      }),
      makeLog('timeout', '[ERROR] Workflow timeout after model activity.', {
        timestamp: timestamp(120_000),
        source: 'error',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 121_000)

    expect(activity?.kind).toBe('workflow_timeout')
    expect(activity?.diagnostic).toBe('workflow_timeout')
  })

  it('ignores timeout words inside model tool output', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('tool-output', [
        '[TOOL] grep completed',
        'Output:',
        '<fsWatcherTimeoutS>0</fsWatcherTimeoutS>',
        '/rest/events [timeout]',
        'ErrTimeout expectTimeout',
      ].join('\n'), {
        timestamp: timestamp(2_000),
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'tool',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_waiting',
      }),
    ], BASE_TIME_MS + 86_000)

    expect(activity).toBeNull()
  })

  it('ignores timeout words inside debug raw messages', () => {
    const activity = deriveCurrentActivity([
      makePrompt(),
      makeLog('debug-raw', 'opencode.raw_message {"content":"/rest/events [timeout] ErrTimeout expectTimeout"}', {
        timestamp: timestamp(2_000),
        source: 'debug',
        audience: 'debug',
        kind: 'milestone',
      }),
    ], BASE_TIME_MS + 86_000)

    expect(activity?.kind).toBe('waiting_first_model_activity')
    expect(activity?.diagnostic).toBeUndefined()
  })

  it('does not warn near timeout at 1m 26s into a 20 minute prompt', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 1_200_000,
        deadlineAt: timestamp(1_200_000),
        timeoutKind: 'ai_response',
      }),
    ], BASE_TIME_MS + 86_000)

    expect(activity?.kind).toBe('waiting_first_model_activity')
    expect(activity?.diagnostic).toBeUndefined()
  })

  it('warns near timeout in the final 2 minutes of a 20 minute prompt', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 1_200_000,
        deadlineAt: timestamp(1_200_000),
        timeoutKind: 'ai_response',
      }),
    ], BASE_TIME_MS + 1_080_000)

    expect(activity?.kind).toBe('near_timeout')
    expect(activity?.label).toBe('Approaching timeout')
    expect(activity?.diagnostic).toBe('near_timeout')
    expect(activity?.active).toBe(true)
  })

  it('uses the 30 second minimum near-timeout window for short prompts', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 100_000,
        deadlineAt: timestamp(100_000),
        timeoutKind: 'opencode_prompt',
      }),
    ], BASE_TIME_MS + 70_000)

    expect(activity?.kind).toBe('near_timeout')
  })

  it('clears near-timeout warnings after model activity starts', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 100_000,
        deadlineAt: timestamp(100_000),
        timeoutKind: 'opencode_prompt',
      }),
      makeLog('model-output', '[MODEL] Work completed before the deadline.', {
        timestamp: timestamp(75_000),
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_waiting',
      }),
    ], BASE_TIME_MS + 90_000)

    expect(activity).toBeNull()
  })

  it('clears near-timeout warnings after prompt completion without requiring text detail', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 360_000,
        deadlineAt: timestamp(360_000),
        timeoutKind: 'per_iteration',
      }),
      makeLog('prompt-result', '[SYS] OpenCode coding_main: openai/gpt-5-codex session=ses_waiting, messages=4, responseChars=512.', {
        timestamp: timestamp(349_000),
        source: 'system',
        kind: 'milestone',
        modelId: 'openai/gpt-5-codex',
      }),
    ], BASE_TIME_MS + 400_000)

    expect(activity).toBeNull()
  })

  it('lets terminal timeout diagnostics override near-timeout warnings', () => {
    const activity = deriveCurrentActivity([
      makePrompt({
        timeoutMs: 120_000,
        deadlineAt: timestamp(120_000),
        timeoutKind: 'opencode_prompt',
      }),
      makeLog('timeout', '[ERROR] OpenCode prompt timed out after 120000ms.', {
        timestamp: timestamp(120_000),
        source: 'error',
        kind: 'error',
      }),
    ], BASE_TIME_MS + 121_000)

    expect(activity?.kind).toBe('model_no_activity_timeout')
    expect(activity?.diagnostic).toBe('model_no_activity_timeout')
  })
})

describe('deriveCurrentActivities', () => {
  it('identifies multiple concurrent active model status computations', () => {
    const prompt1 = makePrompt({
      id: 'prompt-1',
      entryId: 'prompt-1',
      sessionId: 'ses_active_1',
      beadId: 'bead-1',
      modelId: 'openai/gpt-4o',
    })
    const prompt2 = makePrompt({
      id: 'prompt-2',
      entryId: 'prompt-2',
      sessionId: 'ses_active_2',
      beadId: 'bead-2',
      modelId: 'anthropic/claude-3-sonnet',
    })

    const activities = deriveCurrentActivities([prompt1, prompt2], BASE_TIME_MS + 10_000)

    expect(activities).toHaveLength(2)
    expect(activities[0]?.sessionId).toBe('ses_active_1')
    expect(activities[0]?.modelId).toBe('openai/gpt-4o')
    expect(activities[1]?.sessionId).toBe('ses_active_2')
    expect(activities[1]?.modelId).toBe('anthropic/claude-3-sonnet')
  })

  it('filters out superseded prompts of the same session/bead/model', () => {
    const prompt1 = makePrompt({
      id: 'prompt-1',
      entryId: 'prompt-1',
      sessionId: 'ses-1',
      beadId: 'bead-1',
      modelId: 'openai/gpt-4o',
    })
    const prompt2 = makePrompt({
      id: 'prompt-2',
      entryId: 'prompt-2',
      sessionId: 'ses-1',
      beadId: 'bead-1',
      modelId: 'openai/gpt-4o',
    })

    const activities = deriveCurrentActivities([prompt1, prompt2], BASE_TIME_MS + 10_000)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.sessionId).toBe('ses-1')
  })

  it('clears past phase waiting activities when a new phase has started', () => {
    const promptInCouncil = makePrompt({
      id: 'prompt-council',
      entryId: 'prompt-council',
      sessionId: 'ses-council',
      status: 'COUNCIL',
    })

    // A state transition log in the new CODING phase
    const transitionLog = makeLog('transition', '[SYS] Transitioning to CODING status.', {
      status: 'CODING',
      timestamp: timestamp(1000),
    })

    // Before transition: COUNCIL prompt is active
    const activitiesBefore = deriveCurrentActivities([promptInCouncil], BASE_TIME_MS)
    expect(activitiesBefore).toHaveLength(1)
    expect(activitiesBefore[0]?.sessionId).toBe('ses-council')

    // After transition: COUNCIL prompt is from a past phase, so it should be ignored!
    const activitiesAfter = deriveCurrentActivities([promptInCouncil, transitionLog], BASE_TIME_MS + 2000)
    expect(activitiesAfter).toHaveLength(0)
  })

  it('clears past phase activities when the current ticket status is supplied', () => {
    const promptInPrd = makePrompt({
      id: 'prompt-prd',
      entryId: 'prompt-prd',
      sessionId: 'ses-prd',
      status: 'DRAFTING_PRD',
      timeoutMs: 100_000,
      deadlineAt: timestamp(100_000),
    })

    const activities = deriveCurrentActivities(
      [promptInPrd],
      BASE_TIME_MS + 100_000,
      { activeStatus: 'CODING' },
    )

    expect(activities).toHaveLength(0)
  })
})


describe('current warning attribution and lifecycle', () => {
  const secondPrompt = (overrides: Partial<LogEntry> = {}) => makePrompt({
    id: 'prompt-other', entryId: 'prompt-other', sessionId: 'ses_other',
    modelId: 'vendor/other', beadId: undefined, ...overrides,
  })
  const result = (sessionId: string, chars: number, overrides: Partial<LogEntry> = {}) => makeLog(
    `result-${sessionId}`, `OpenCode council: model session=${sessionId}, messages=3, responseChars=${chars}.`,
    { timestamp: timestamp(4_000), ...overrides },
  )
  const text = (overrides: Partial<LogEntry> = {}) => makeLog('text', 'Here is the answer.', {
    source: 'model:openai/gpt-5-codex', audience: 'ai', kind: 'text',
    sessionId: 'ses_waiting', timestamp: timestamp(5_000), ...overrides,
  })

  it('applies an empty council result only to its session, including legacy text-only attribution', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt(), result('ses_other', 0),
    ], BASE_TIME_MS + 10_000)
    expect(activities.map(a => [a.sessionId, a.kind])).toEqual([
      ['ses_waiting', 'waiting_first_model_activity'], ['ses_other', 'empty_model_output'],
    ])
    expect(activities[1]?.elapsedMs).toBe(4_000)
  })

  it('keeps distinct sessions running the same model and bead independent', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt({ modelId: 'openai/gpt-5-codex', beadId: 'bead-2' }),
    ])
    expect(activities).toHaveLength(2)
  })

  it('does not assign an unscoped failure to every concurrent model', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt(),
      makeLog('error', '[ERROR] OpenCode prompt timed out after 1000ms.', {
        source: 'error', kind: 'error', timestamp: timestamp(1_000),
      }),
    ])
    expect(activities.map(a => a.kind)).toEqual(['waiting_first_model_activity', 'waiting_first_model_activity'])
  })

  it('uses model attribution when a unique result has no session id', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt(),
      makeLog('empty', 'OpenCode returned no response text (stage: council, messages: 1).', {
        modelId: 'vendor/other', timestamp: timestamp(1_000),
      }),
    ])
    expect(activities.map(a => a.kind)).toEqual(['waiting_first_model_activity', 'empty_model_output'])
  })

  it('does not use model-only evidence to guess between two sessions of that model', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt({ modelId: 'openai/gpt-5-codex' }),
      makeLog('empty', 'OpenCode returned no response text (stage: council, messages: 1).', {
        modelId: 'openai/gpt-5-codex', timestamp: timestamp(1_000),
      }),
    ])
    expect(activities.every(a => a.kind === 'waiting_first_model_activity')).toBe(true)
  })

  it.each([
    ['bead', { beadId: 'bead-other' }],
    ['model', { modelId: 'vendor/other' }],
    ['session', { sessionId: 'ses_other' }],
  ])('ignores explicitly foreign %s events', (_name, fields) => {
    expect(deriveCurrentActivity([
      makePrompt(), makeLog('foreign', 'OpenCode returned no response text (stage: council, messages: 1).', {
        timestamp: timestamp(1_000), ...fields,
      }),
    ])?.kind).toBe('waiting_first_model_activity')
  })

  it('does not let later phases or attempts diagnose an earlier prompt', () => {
    expect(deriveCurrentActivities([
      makePrompt({ phaseAttempt: 2 }),
      result('ses_waiting', 0, { phaseAttempt: 1 }),
      result('ses_waiting', 0, { status: 'PRD', phaseAttempt: 2 }),
    ], BASE_TIME_MS + 10_000, { activeStatus: 'CODING', activePhaseAttempt: 2 })[0]?.kind)
      .toBe('waiting_first_model_activity')
  })

  it('uses the newest attempt even when an older event was timestamped later', () => {
    expect(deriveCurrentActivities([
      makePrompt({ phaseAttempt: 1 }), result('ses_waiting', 0, { phaseAttempt: 1 }),
      secondPrompt({ phaseAttempt: 2, timestamp: timestamp(2_000) }),
    ]).map(a => a.sessionId)).toEqual(['ses_other'])
  })

  it('hides the previous attempt while the current attempt has no prompts yet', () => {
    expect(deriveCurrentActivities([makePrompt(), result('ses_waiting', 0)], BASE_TIME_MS, {
      activePhaseAttempt: 2,
    })).toEqual([])
  })

  it.each([
    [0, 1, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0], [1, 0, 2], [0, 2, 1],
  ])('sorts mixed restored/live evidence before finding events: %s %s %s', (a, b, c) => {
    const entries = [makePrompt(), result('ses_waiting', 0), result('ses_waiting', 12, { timestamp: timestamp(5_000) })]
    expect(deriveCurrentActivities([entries[a]!, entries[b]!, entries[c]!])).toEqual([])
  })

  it.each(['Late narration', '   '])('requires a successful result to resolve empty output, even with late text: %j', content => {
    expect(deriveCurrentActivity([
      makePrompt(), result('ses_waiting', 0),
      normalizeLogRecord({ type: 'model_output', content, source: 'model:openai/gpt-5-codex',
        audience: 'ai', kind: 'text', sessionId: 'ses_waiting', timestamp: timestamp(5_000) }, 'CODING'),
    ])?.kind).toBe('empty_model_output')
  })

  it('clears an empty-response warning after a successful result', () => {
    expect(deriveCurrentActivities([
      makePrompt(), result('ses_waiting', 0),
      result('ses_waiting', 12, { id: 'recovered', timestamp: timestamp(6_000) }),
    ])).toEqual([])
  })

  it('does not clear a genuinely empty result just because reasoning/tool activity exists', () => {
    expect(deriveCurrentActivity([
      makePrompt(), text({ kind: 'reasoning', timestamp: timestamp(1_000) }),
      result('ses_waiting', 0), text({ kind: 'tool' }),
    ])?.kind).toBe('empty_model_output')
  })

  it.each([
    ['provider_retry_timeout', '[ERROR] OpenCode retry grace window expired after 60000ms.'],
    ['provider_timeout_preserved', 'OpenCode/provider timeout for session ses_waiting; preserving session for Continue.'],
    ['iteration_timeout', 'Iteration timeout for bead bead-2 attempt 1; resetting for attempt 2 of 3.'],
    ['model_no_activity_timeout', '[ERROR] OpenCode prompt timed out after 120000ms.'],
  ])('clears %s when a replacement session retries the same work', (_kind, line) => {
    const activities = deriveCurrentActivities([
      makePrompt(), makeLog('failure', line, {
        source: 'error', kind: 'error', sessionId: 'ses_waiting', timestamp: timestamp(1_000),
      }),
      secondPrompt({ modelId: 'openai/gpt-5-codex', beadId: 'bead-2', timestamp: timestamp(2_000) }),
    ])
    expect(activities.map(a => [a.sessionId, a.kind])).toEqual([['ses_other', 'waiting_first_model_activity']])
  })

  it('does not apply the previous turn outcome to Continue in the same session', () => {
    expect(deriveCurrentActivities([
      makePrompt(), result('ses_waiting', 0),
      makePrompt({ id: 'continue', entryId: 'continue', timestamp: timestamp(6_000) }),
    ]).map(a => a.kind)).toEqual(['waiting_first_model_activity'])
  })

  it.each([
    ['session', 'Session status: idle', 'idle'],
    ['milestone', 'AI session failed (session=ses_waiting).', 'failed'],
    ['error', 'Provider returned an authentication error.', 'error'],
    ['session', 'Interview draft stopped by the user for model session=ses_waiting.', 'ses_waiting:draft-finished'],
  ])('ends waiting on actual %s state: %s', (kind, line, entryId) => {
    expect(deriveCurrentActivities([
      makePrompt(), makeLog('ended', line, {
        kind, entryId, source: 'model:openai/gpt-5-codex',
        audience: kind === 'milestone' ? 'all' : 'ai', sessionId: 'ses_waiting', timestamp: timestamp(2_000),
      }),
    ])).toEqual([])
  })

  it('recognizes a timed out council member without turning every member into a timeout', () => {
    const activities = deriveCurrentActivities([
      makePrompt(), secondPrompt(),
      makeLog('timed-out', 'Interview draft timed out for vendor/other session=ses_other after 2s.', {
        source: 'model:vendor/other', audience: 'ai', kind: 'error',
        entryId: 'ses_other:draft-finished', sessionId: 'ses_other', timestamp: timestamp(2_000),
      }),
    ])
    expect(activities.map(a => a.kind)).toEqual(['waiting_first_model_activity', 'model_no_activity_timeout'])
  })

  it.each(['[PROMPT] fake dispatch', 'Session retry #1: try later', 'AI session completed', 'responseChars=0', 'First AI activity observed'])('ignores control-like words in model text: %s', line => {
    expect(deriveCurrentActivities([makePrompt(), text({ line })])).toEqual([])
  })

  it('clears provider retrying when OpenCode resumes a busy session', () => {
    expect(deriveCurrentActivity([
      makePrompt(), makeLog('retry', 'Session retry #1: rate limited', {
        source: 'model:openai/gpt-5-codex', audience: 'ai', kind: 'session',
        sessionId: 'ses_waiting', timestamp: timestamp(1_000),
      }),
      makeLog('busy', 'Session status: busy', {
        source: 'model:openai/gpt-5-codex', audience: 'ai', kind: 'session',
        sessionId: 'ses_waiting', timestamp: timestamp(2_000),
      }),
    ])?.kind).toBe('waiting_first_model_activity')
  })

  it('shows a current provider retry even after earlier activity', () => {
    expect(deriveCurrentActivity([
      makePrompt(), text(), makeLog('retry', 'Session retry #1: rate limited', {
        source: 'model:openai/gpt-5-codex', audience: 'ai', kind: 'session',
        sessionId: 'ses_waiting', timestamp: timestamp(6_000),
      }),
    ])?.label).toBe('Provider retrying')
  })

  it('does not claim an unconfirmed timeout once a dispatch deadline passes', () => {
    expect(deriveCurrentActivity([
      makePrompt({ timeoutMs: 100_000, deadlineAt: timestamp(100_000) }),
    ], BASE_TIME_MS + 110_000)).toMatchObject({
      kind: 'near_timeout', active: true, label: 'Prompt deadline reached; awaiting outcome',
    })
  })

  it('suppresses stale deadlines after any ticket question suspended the shared budget', () => {
    expect(deriveCurrentActivity([
      makePrompt({ timeoutMs: 100_000, deadlineAt: timestamp(100_000) }),
      makeLog('question', '[QUESTION] AI asked 1 question: Continue?', {
        kind: 'session', source: 'model:vendor/other', audience: 'ai',
        sessionId: 'ses_other', timestamp: timestamp(10_000),
      }),
    ], BASE_TIME_MS + 90_000)?.kind).toBe('waiting_first_model_activity')
  })

  it('suppresses near timeout with authoritative pending question state', () => {
    expect(deriveCurrentActivities([
      makePrompt({ timeoutMs: 100_000, deadlineAt: timestamp(100_000) }),
    ], BASE_TIME_MS + 90_000, { suppressNearTimeout: true })[0]?.kind).toBe('waiting_first_model_activity')
  })

  it.each([
    { timeoutMs: 0, deadlineAt: timestamp(100_000) },
    { timeoutMs: Number.NaN, deadlineAt: timestamp(100_000) },
    { timeoutMs: 100_000, deadlineAt: 'invalid' },
    { timeoutMs: 100_000 },
  ])('does not infer a deadline from invalid metadata: %j', metadata => {
    expect(deriveCurrentActivity([makePrompt(metadata)], BASE_TIME_MS + 90_000)?.kind)
      .toBe('waiting_first_model_activity')
  })

  it('handles missing timestamps without inventing elapsed time', () => {
    expect(deriveCurrentActivity([makePrompt({ timestamp: undefined })])?.elapsedMs).toBeUndefined()
  })

  it('formats hour durations and clamps negative elapsed time', () => {
    expect(formatElapsedDuration(3_723_000)).toBe('1h 2m')
    expect(formatElapsedDuration(-1_000)).toBe('0s')
  })
})


describe('durable log normalization', () => {
  it.each(['Session status: idle', 'AI session failed (session=ses_waiting).'])('ends waiting after normalizing %s', content => {
    const entry = normalizeLogRecord({
      type: 'info', content, kind: content.startsWith('Session') ? 'session' : 'milestone',
      source: 'model:openai/gpt-5-codex', audience: 'all', sessionId: 'ses_waiting',
      timestamp: timestamp(2_000),
    }, 'CODING')
    expect(deriveCurrentActivity([makePrompt(), entry])).toBeNull()
  })

  it('recognizes a normalized empty-response milestone without relying on a summary', () => {
    const entry = normalizeLogRecord({
      type: 'info', content: 'OpenCode returned no response text (stage: council, messages: 1).',
      kind: 'milestone', source: 'system', audience: 'all', sessionId: 'ses_waiting', timestamp: timestamp(2_000),
    }, 'CODING')
    expect(deriveCurrentActivity([makePrompt(), entry])?.kind).toBe('empty_model_output')
  })
})


it('recognizes retry exhaustion inside an application-generated council failure row', () => {
  expect(deriveCurrentActivity([
    makePrompt(), makeLog('council-failed', '[ERROR] Interview draft failed (OpenCode retry budget exhausted after 2 retry events) for model session=ses_waiting.', {
      kind: 'error', source: 'model:openai/gpt-5-codex', audience: 'ai',
      entryId: 'ses_waiting:draft-finished', sessionId: 'ses_waiting', timestamp: timestamp(5_000),
    }),
  ])?.kind).toBe('provider_retry_timeout')
})


it('does not invent terminal elapsed time when the diagnostic has no timestamp', () => {
  expect(deriveCurrentActivity([
    makePrompt(), makeLog('undated-timeout', '[ERROR] OpenCode prompt timed out after 120000ms.', {
      source: 'error', kind: 'error', timestamp: undefined,
    }),
  ], BASE_TIME_MS + 500_000)).toMatchObject({ kind: 'model_no_activity_timeout', elapsedMs: undefined })
})
