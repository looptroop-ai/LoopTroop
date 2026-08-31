import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../ModelPicker'
import { useAllOpenCodeModels, useOpenCodeModels, type OpenCodeModel } from '@/hooks/useOpenCodeModels'

vi.mock('@/hooks/useOpenCodeModels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useOpenCodeModels')>('@/hooks/useOpenCodeModels')
  return {
    ...actual,
    useOpenCodeModels: vi.fn(),
    useAllOpenCodeModels: vi.fn(),
  }
})

const models: OpenCodeModel[] = [
  {
    id: 'gpt-alpha',
    name: 'GPT Alpha',
    fullId: 'openai/gpt-alpha',
    providerID: 'openai',
    providerName: 'OpenAI',
    family: 'gpt',
    costInput: 1,
    costOutput: 2,
    contextWindow: 128_000,
    canReason: true,
    canSeeImages: true,
    canUseTools: true,
    status: 'stable',
  },
  {
    id: 'claude-gpt-bridge',
    name: 'Claude GPT Bridge',
    fullId: 'anthropic/claude-gpt-bridge',
    providerID: 'anthropic',
    providerName: 'Anthropic',
    family: 'claude',
    costInput: 3,
    costOutput: 15,
    contextWindow: 200_000,
    canReason: true,
    canSeeImages: false,
    canUseTools: true,
    status: 'stable',
  },
  {
    id: 'local/same-name',
    name: 'local/same-name',
    fullId: 'local/same-name',
    providerID: 'local',
    providerName: 'Local',
    family: 'local',
    costInput: 0,
    costOutput: 0,
    contextWindow: 8_000,
    canReason: false,
    canSeeImages: false,
    canUseTools: true,
    status: 'stable',
  },
]

function mockModelsQuery(data: OpenCodeModel[] = models) {
  const result = {
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
  }

  vi.mocked(useOpenCodeModels).mockReturnValue(result as ReturnType<typeof useOpenCodeModels>)
  vi.mocked(useAllOpenCodeModels).mockReturnValue(result as ReturnType<typeof useAllOpenCodeModels>)
}

describe('ModelPicker', () => {
  beforeEach(() => {
    mockModelsQuery()
  })

  it('allows provider groups to collapse while search is active', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'gpt' } })

    expect(screen.getByText('GPT Alpha')).toBeInTheDocument()

    fireEvent.click(screen.getByText('OpenAI'))

    expect(screen.queryByText('GPT Alpha')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('OpenAI'))

    expect(screen.getByText('GPT Alpha')).toBeInTheDocument()
  })

  it('loads the full catalog only after Show all providers is selected', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)

    expect(useAllOpenCodeModels).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Show all providers/i }))

    expect(useAllOpenCodeModels).toHaveBeenLastCalledWith(true)
  })

  it('shows the stored full id in parentheses beside the pretty name in the open list', () => {
    render(<ModelPicker value="openai/gpt-alpha" onChange={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Pick a model' })
    expect(trigger).toHaveTextContent('GPT Alpha')
    expect(trigger).toHaveTextContent('OpenAI')
    expect(trigger).not.toHaveTextContent('(openai/gpt-alpha)')
    expect(screen.queryByText('(openai/gpt-alpha)')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    const dropdown = screen.getByRole('listbox', { name: 'Available models' })
    expect(within(dropdown).getByText('GPT Alpha')).toBeInTheDocument()
    expect(within(dropdown).getByText('(openai/gpt-alpha)')).toBeInTheDocument()
    expect(trigger).not.toHaveTextContent('(openai/gpt-alpha)')
  })

  it('does not repeat the full id when it already matches the pretty name', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))

    expect(screen.getByText('local/same-name')).toBeInTheDocument()
    expect(screen.queryByText('(local/same-name)')).not.toBeInTheDocument()
  })

  it('finds a model when the search query is the stored full id', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'openai/gpt-alpha' } })

    expect(screen.getByText('GPT Alpha')).toBeInTheDocument()
    expect(screen.getByText('(openai/gpt-alpha)')).toBeInTheDocument()
    expect(screen.queryByText('Claude GPT Bridge')).not.toBeInTheDocument()
    expect(screen.queryByText('local/same-name')).not.toBeInTheDocument()
  })
})

/**
 * The list is portaled to `document.body`, so an unstopped Escape carried on to the
 * Configuration window's own document listener and closed the whole thing instead of
 * the picker in front of it.
 */
describe('ModelPicker — Escape', () => {
  beforeEach(() => {
    mockModelsQuery()
  })

  it('closes the list and returns focus to the trigger', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Pick a model' })
    fireEvent.click(trigger)

    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' })

    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Escape to itself so the window behind it stays open', () => {
    const onDocumentEscape = vi.fn()
    document.addEventListener('keydown', onDocumentEscape)
    try {
      render(<ModelPicker value="" onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
      onDocumentEscape.mockClear()

      fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' })

      expect(onDocumentEscape).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', onDocumentEscape)
    }
  })

  it('lets Escape through while the list is closed', () => {
    const onDocumentEscape = vi.fn()
    document.addEventListener('keydown', onDocumentEscape)
    try {
      render(<ModelPicker value="" onChange={vi.fn()} />)

      fireEvent.keyDown(screen.getByRole('button', { name: 'Pick a model' }), { key: 'Escape' })

      expect(onDocumentEscape).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', onDocumentEscape)
    }
  })
})
