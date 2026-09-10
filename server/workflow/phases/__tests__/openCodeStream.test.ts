import { describe, expect, it } from 'vitest'
import { createOpenCodeStreamState, formatToolState } from '../openCodeStream'
import { formatTodoTransitionSummary } from '../todoSummary'
import type { StreamEvent } from '../../../opencode/types'

type ToolEvent = Extract<StreamEvent, { type: 'tool' }>
type TodoEvent = Extract<StreamEvent, { type: 'todo' }>

function toolEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { type: 'tool', ...overrides } as ToolEvent
}

const limits = { inputMaxChars: 100, outputMaxChars: 100, errorMaxChars: 100 }

/**
 * The stream state and the tool-event renderer.
 *
 * `openCodeStream.ts` came out of PR-13's `helpers.ts` split as the largest of
 * the seven modules and the one Codacy flags for complexity; `formatToolState`
 * is the branchiest thing in it that can be called without a session.
 */
describe('createOpenCodeStreamState', () => {
  it('starts empty', () => {
    const state = createOpenCodeStreamState()

    expect(state.seenFirstActivity).toBe(false)
    expect(state.liveKinds.size).toBe(0)
    expect(state.liveContents.size).toBe(0)
    expect(state.liveStreamEmissions.size).toBe(0)
    expect(state.todoStatuses.size).toBe(0)
    expect(state.liveTextMessages.size).toBe(0)
    expect(state.textPartToMessageIds.size).toBe(0)
    expect(state.finalizedTextEntryIds.size).toBe(0)
    expect(state.finalizedDetailEntryIds.size).toBe(0)
  })

  it('gives each call its own collections', () => {
    // One shared map here would leak one run's tool output into the next.
    const first = createOpenCodeStreamState()
    const second = createOpenCodeStreamState()

    first.todoStatuses.set('task', 'in_progress')
    first.finalizedTextEntryIds.add('entry-1')

    expect(second.todoStatuses.size).toBe(0)
    expect(second.finalizedTextEntryIds.size).toBe(0)
  })
})

describe('formatToolState', () => {
  it('names the tool and its status, and ends a bare line with a full stop', () => {
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed' }), limits))
      .toBe('[TOOL] bash completed.')
  })

  it('falls back for a tool and a status the event did not carry', () => {
    expect(formatToolState(toolEvent(), limits)).toBe('[TOOL] tool unknown.')
  })

  it('appends the title after the status', () => {
    expect(formatToolState(toolEvent({ tool: 'read', status: 'running', title: 'src/app.ts' }), limits))
      .toBe('[TOOL] read running: src/app.ts.')
  })

  it.each([
    ['a negative duration', -1],
    ['a duration that is not a number', Number.NaN],
    ['an infinite duration', Number.POSITIVE_INFINITY],
  ])('omits %s rather than rendering it', (_, durationMs) => {
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', durationMs }), limits))
      .toBe('[TOOL] bash completed.')
  })

  it('renders a duration it can trust, zero included', () => {
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', durationMs: 0 }), limits))
      .toBe('[TOOL] bash completed (0ms).')
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', durationMs: 2350 }), limits))
      .toBe('[TOOL] bash completed (2.35s).')
  })

  it('sections input, output and error, in that order', () => {
    const rendered = formatToolState(toolEvent({
      tool: 'bash',
      status: 'error',
      input: { command: 'ls' },
      output: 'nothing',
      error: 'exit 1',
    }), limits)

    expect(rendered).toBe([
      '[TOOL] bash error',
      'Input:',
      '{\n  "command": "ls"\n}',
      'Output:',
      'nothing',
      'Error:',
      'exit 1',
    ].join('\n'))
  })

  it('omits an input object with no keys', () => {
    // `{}` is what a no-argument tool reports; an "Input:" heading over an
    // empty object reads as a tool that was called wrongly.
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', input: {} }), limits))
      .toBe('[TOOL] bash completed.')
  })

  it('truncates each section against its own limit', () => {
    const rendered = formatToolState(toolEvent({
      tool: 'bash',
      status: 'error',
      output: 'o'.repeat(50),
      error: 'e'.repeat(50),
    }), { outputMaxChars: 10, errorMaxChars: 20 })

    expect(rendered).toContain(`${'o'.repeat(10)}\n… (truncated 40 chars)`)
    expect(rendered).toContain(`${'e'.repeat(20)}\n… (truncated 30 chars)`)
  })

  it('lists attachments with a normalised filename and mime type', () => {
    const rendered = formatToolState(toolEvent({
      tool: 'read',
      status: 'completed',
      attachments: [
        { filename: '  report\n final.pdf ', mime: 'application/pdf' },
        { filename: '', mime: '   ' },
      ],
    } as Partial<ToolEvent>), limits)

    expect(rendered).toBe([
      '[TOOL] read completed',
      'Attachments: 2',
      '- report final.pdf (application/pdf)',
      '- unnamed attachment',
    ].join('\n'))
  })

  it('omits an empty attachment list', () => {
    expect(formatToolState(toolEvent({ tool: 'read', status: 'completed', attachments: [] }), limits))
      .toBe('[TOOL] read completed.')
  })

  it('reports a compaction time it can read, and nothing when it cannot', () => {
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', compactedAt: 0 }), limits))
      .toBe('[TOOL] bash completed\nCompacted: 1970-01-01T00:00:00.000Z')
    expect(formatToolState(toolEvent({ tool: 'bash', status: 'completed', compactedAt: Number.NaN }), limits))
      .toBe('[TOOL] bash completed.')
  })
})

describe('formatTodoTransitionSummary', () => {
  function todos(...entries: Array<[string, string]>): TodoEvent['todos'] {
    return entries.map(([content, status]) => ({ content, status, priority: 'medium' })) as TodoEvent['todos']
  }

  it('reports nothing when no todo changed', () => {
    const state = createOpenCodeStreamState()
    state.todoStatuses.set('write the test', 'in_progress')

    expect(formatTodoTransitionSummary(todos(['write the test', 'in_progress']), state)).toBeNull()
  })

  it('reports a todo it has seen before whenever its status moves', () => {
    const state = createOpenCodeStreamState()
    formatTodoTransitionSummary(todos(['write the test', 'in_progress']), state)

    expect(formatTodoTransitionSummary(todos(['write the test', 'completed']), state))
      .toBe('[TASK] 1 completed: completed: write the test')
  })

  it('ignores a first sighting that is still pending, and keeps one that is not', () => {
    // Every todo is announced on the first event; reporting them all would
    // print the whole list as "transitions" the moment a run starts.
    const state = createOpenCodeStreamState()

    expect(formatTodoTransitionSummary(todos(['later', 'pending']), state)).toBeNull()
    expect(formatTodoTransitionSummary(todos(['now', 'in_progress']), state))
      .toBe('[TASK] 1 in progress: in_progress: now')
  })

  it('counts each status and spells it without underscores', () => {
    const state = createOpenCodeStreamState()

    expect(formatTodoTransitionSummary(
      todos(['a', 'in_progress'], ['b', 'in_progress'], ['c', 'completed']),
      state,
    )).toBe('[TASK] 2 in progress, 1 completed: in_progress: a; in_progress: b; completed: c')
  })

  it('lists four examples and counts the rest', () => {
    const state = createOpenCodeStreamState()
    const summary = formatTodoTransitionSummary(
      todos(['a', 'completed'], ['b', 'completed'], ['c', 'completed'], ['d', 'completed'], ['e', 'completed'], ['f', 'completed']),
      state,
    )

    expect(summary).toBe(
      '[TASK] 6 completed: completed: a; completed: b; completed: c; completed: d; +2 more',
    )
  })

  it('remembers the new status even for todos it did not report', () => {
    const state = createOpenCodeStreamState()
    formatTodoTransitionSummary(todos(['later', 'pending']), state)

    expect(state.todoStatuses.get('later')).toBe('pending')
    // Which is what makes the next move a transition rather than another
    // first sighting.
    expect(formatTodoTransitionSummary(todos(['later', 'in_progress']), state))
      .toBe('[TASK] 1 in progress: in_progress: later')
  })
})
