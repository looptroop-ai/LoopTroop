import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptResetRequest } from '../PromptEditor'
import { PromptsDialog } from '../PromptsDialog'

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: true,
  error: undefined as unknown,
  resetPending: false,
  resetAll: vi.fn(),
}))

vi.mock('@/hooks/usePrompts', () => ({
  usePromptCatalog: () => ({ data: state.data, isLoading: state.isLoading, error: state.error }),
  useResetAllPrompts: () => ({ isPending: state.resetPending, mutateAsync: state.resetAll }),
}))

vi.mock('../PromptEditor', () => ({
  PromptEditor: ({
    promptId,
    wordWrap,
    onToggleWordWrap,
    resetRequest,
    onDirtyChange,
  }: {
    promptId: string
    wordWrap: boolean
    onToggleWordWrap: () => void
    resetRequest: PromptResetRequest | null
    onDirtyChange: (dirty: boolean) => void
  }) => (
    <section>
      <output data-testid="selected-prompt">{promptId}</output>
      <output data-testid="word-wrap">{String(wordWrap)}</output>
      <output data-testid="reset-request">{resetRequest?.status ?? 'none'}</output>
      <button onClick={() => onDirtyChange(true)}>Make editor dirty</button>
      <button onClick={onToggleWordWrap}>Toggle word wrap</button>
    </section>
  ),
}))

const catalog = {
  groups: [
    {
      id: 'planning',
      label: 'Planning',
      statuses: [{
        status: 'interview',
        label: 'Interview',
        prompts: [
          { id: 'first', description: 'First prompt', step: 1, modified: false },
          { id: 'second', description: 'Second prompt', step: 1, modified: true },
        ],
      }],
    },
    {
      id: 'general',
      label: 'General',
      statuses: [{
        status: 'rules',
        label: 'Rules',
        prompts: [{ id: 'rules', description: 'Global rules', step: null, modified: false }],
      }],
    },
  ],
  modifiedCount: 1,
  templatesDir: '/prompts',
  warnings: [{ id: 'unknown', message: 'This prompt is not in the catalog.' }],
}

beforeEach(() => {
  state.data = undefined
  state.isLoading = true
  state.error = undefined
  state.resetPending = false
  state.resetAll.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PromptsDialog', () => {
  it('shows loading and both error fallback messages', () => {
    const { rerender } = render(<PromptsDialog />)
    expect(screen.getByText('Loading prompts…')).toBeInTheDocument()

    state.isLoading = false
    state.error = new Error('catalog unavailable')
    rerender(<PromptsDialog />)
    expect(screen.getByText('catalog unavailable')).toBeInTheDocument()

    state.error = undefined
    rerender(<PromptsDialog />)
    expect(screen.getByText('Failed to load prompts.')).toBeInTheDocument()
  })

  it('selects prompts with discard protection and keeps sidebar settings', async () => {
    state.data = catalog
    state.isLoading = false
    const onDirtyChange = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PromptsDialog onDirtyChange={onDirtyChange} />)

    await waitFor(() => expect(screen.getByTestId('selected-prompt')).toHaveTextContent('first'))
    expect(screen.getByText(/This prompt is not in the catalog/)).toBeInTheDocument()
    expect(screen.getByText('1 modified')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Expand Planning'))
    fireEvent.click(screen.getByRole('button', { name: 'Second prompt' }))
    expect(screen.getByTestId('selected-prompt')).toHaveTextContent('second')
    fireEvent.click(screen.getByRole('button', { name: 'Make editor dirty' }))
    fireEvent.click(screen.getByRole('button', { name: 'First prompt' }))
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved prompt changes?')
    expect(screen.getByTestId('selected-prompt')).toHaveTextContent('second')

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'First prompt' }))
    expect(screen.getByTestId('selected-prompt')).toHaveTextContent('first')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle word wrap' }))
    expect(screen.getByTestId('word-wrap')).toHaveTextContent('true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide list' }))
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show list' }))
    expect(screen.getByRole('navigation')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Expand General'))
    fireEvent.click(screen.getByTitle('Global rules'))
    expect(screen.getByTestId('selected-prompt')).toHaveTextContent('rules')
  })

  it('handles successful reset confirmation and reports reset failures', async () => {
    state.data = catalog
    state.isLoading = false
    render(<PromptsDialog />)
    await waitFor(() => expect(screen.getByTestId('selected-prompt')).toHaveTextContent('first'))

    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Discard all prompt edits?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    await waitFor(() => expect(screen.getByTestId('reset-request')).toHaveTextContent('success'))
    expect(state.resetAll).toHaveBeenCalledOnce()
    expect(screen.queryByText('Discard all prompt edits?')).not.toBeInTheDocument()

    state.resetAll.mockRejectedValueOnce(new Error('reset failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('reset failed'))
    expect(screen.getByTestId('reset-request')).toHaveTextContent('failure')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    state.data = {
      ...catalog,
      modifiedCount: 0,
      groups: [{ id: 'empty', label: 'Empty', statuses: [{ status: 'empty', label: 'Empty', prompts: [] }] }],
    }
    cleanup()
    render(<PromptsDialog />)
    expect(screen.getByText('Select a prompt to edit.')).toBeInTheDocument()
    expect(screen.getByText('All prompts are at their defaults')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toBeDisabled()
  })

  it('keeps reset confirmation available in the collapsed sidebar and disables it while pending', async () => {
    state.data = catalog
    state.isLoading = false
    const { rerender } = render(<PromptsDialog />)
    await waitFor(() => expect(screen.getByTestId('selected-prompt')).toHaveTextContent('first'))

    fireEvent.click(screen.getByRole('button', { name: 'Hide list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
    expect(screen.getByText('Discard all prompt edits?')).toBeInTheDocument()

    state.resetPending = true
    rerender(<PromptsDialog />)
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Discard all prompt edits?')).not.toBeInTheDocument()

    state.resetPending = false
    state.resetAll.mockRejectedValueOnce('reset rejected')
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to reset prompts.'))
  })
})
