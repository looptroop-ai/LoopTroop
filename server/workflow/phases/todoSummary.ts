import type { StreamEvent } from '../../opencode/types'
import type { OpenCodeStreamState } from './types'

export function formatTodoTransitionSummary(
  todos: Extract<StreamEvent, { type: 'todo' }>['todos'],
  state: OpenCodeStreamState,
): string | null {
  const transitions: Array<{ content: string; status: string; priority: string }> = []

  for (const todo of todos) {
    const previous = state.todoStatuses.get(todo.content)
    if (previous !== todo.status && (previous !== undefined || todo.status === 'in_progress' || todo.status === 'completed' || todo.status === 'cancelled')) {
      transitions.push(todo)
    }
    state.todoStatuses.set(todo.content, todo.status)
  }

  if (transitions.length === 0) return null

  const counts = transitions.reduce<Record<string, number>>((acc, todo) => {
    acc[todo.status] = (acc[todo.status] ?? 0) + 1
    return acc
  }, {})
  const countText = Object.entries(counts)
    .map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`)
    .join(', ')
  const examples = transitions
    .slice(0, 4)
    .map((todo) => `${todo.status}: ${todo.content}`)
  const suffix = transitions.length > examples.length ? `; +${transitions.length - examples.length} more` : ''
  return `[TASK] ${countText}: ${examples.join('; ')}${suffix}`
}
