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

    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }))

    expect(screen.queryByRole('option', { name: /GPT Alpha/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }))

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

describe('ModelPicker — closing', () => {
  beforeEach(() => {
    mockModelsQuery()
  })

  it('hands focus back to the trigger after a model is chosen', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Pick a model' })
    fireEvent.click(trigger)

    // Selecting closes the list from inside it, detaching the button the user was on.
    fireEvent.click(screen.getByRole('option', { name: /GPT Alpha/ }))

    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('stays open for a click in its own list', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))

    fireEvent.mouseDown(screen.getByLabelText('Search models'))

    expect(screen.getByLabelText('Search models')).toBeInTheDocument()
  })

  it('closes for a click in a list belonging to another picker', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))

    // Another picker's portal: same kind of surface, a different owner. Matching on
    // "is a model list" rather than on the owner left this one open.
    const otherList = document.createElement('div')
    otherList.setAttribute('data-lt-portal', 'some-other-picker')
    document.body.appendChild(otherList)

    fireEvent.mouseDown(otherList)

    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument()
    document.body.removeChild(otherList)
  })
})

describe('ModelPicker — combobox', () => {
  beforeEach(() => {
    mockModelsQuery()
  })

  it('links the search field to options only, keeping filters and disclosures outside the listbox', () => {
    render(<ModelPicker value="openai/gpt-alpha" onChange={vi.fn()} disabledValues={['anthropic/claude-gpt-bridge']} />)
    const trigger = screen.getByRole('button', { name: 'Pick a model' })
    fireEvent.click(trigger)

    const search = screen.getByRole('combobox', { name: 'Search models' })
    const listbox = screen.getByRole('listbox', { name: 'Available models' })
    expect(search).toHaveAttribute('aria-controls', listbox.id)
    expect(search).toHaveAttribute('aria-expanded', 'true')
    expect(search).toHaveAttribute('aria-autocomplete', 'list')
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toContainElement(search)
    expect(within(listbox).queryByRole('button')).not.toBeInTheDocument()
    expect(within(listbox).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(listbox).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(listbox).getByRole('group', { name: 'OpenAI' })).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: /GPT Alpha/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(listbox).getByRole('option', { name: /Claude GPT Bridge/ })).toHaveAttribute('aria-disabled', 'true')
    for (const option of within(listbox).getAllByRole('option')) expect(option).toHaveAttribute('tabindex', '-1')
  })

  it('uses arrows and Enter to choose an enabled model while focus stays in search', () => {
    const onChange = vi.fn()
    render(<ModelPicker value="" onChange={onChange} disabledValues={['anthropic/claude-gpt-bridge']} />)
    const trigger = screen.getByRole('button', { name: 'Pick a model' })
    fireEvent.click(trigger)
    const search = screen.getByRole('combobox')
    search.focus()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const first = screen.getByRole('option', { name: /GPT Alpha/ })
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const last = screen.getByRole('option', { name: /local\/same-name/ })
    expect(search).toHaveAttribute('aria-activedescendant', last.id)
    expect(first).toHaveAttribute('aria-selected', 'false')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledExactlyOnceWith('openai/gpt-alpha')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('skips collapsed groups and starts at the last option for ArrowUp', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    const disclosure = screen.getByRole('button', { name: /^Local/ })
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(disclosure.getAttribute('aria-controls')!)).toHaveAttribute('hidden')
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Claude GPT Bridge/ }).id)
  })

  it('clears active suggestions when searching and does not accept empty results', () => {
    const onChange = vi.fn()
    render(<ModelPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.change(search, { target: { value: 'missing-model' } })
    expect(search).not.toHaveAttribute('aria-activedescendant')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(onChange).not.toHaveBeenCalled()
    expect(within(screen.getByRole('listbox')).queryByText(/No models match/)).not.toBeInTheDocument()
    expect(screen.getByText(/No models match/)).toBeInTheDocument()
  })

  it('leaves text editing and Tab keys to the browser', () => {
    render(<ModelPicker value="" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    const search = screen.getByRole('combobox')
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'Tab']) {
      expect(fireEvent.keyDown(search, { key })).toBe(true)
    }
  })

  it('drops an active option when refreshed configuration disables it', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ModelPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick a model' }))
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search).toHaveAttribute('aria-activedescendant')

    rerender(<ModelPicker value="" onChange={onChange} disabledValues={models.map(model => model.fullId)} />)
    expect(search).not.toHaveAttribute('aria-activedescendant')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps independent IDs when several model pickers are open', () => {
    render(<><ModelPicker value="" onChange={vi.fn()} /><ModelPicker value="" onChange={vi.fn()} /></>)
    for (const trigger of screen.getAllByRole('button', { name: 'Pick a model' })) fireEvent.click(trigger)
    const searches = screen.getAllByRole('combobox')
    expect(searches[0]!.getAttribute('aria-controls')).not.toBe(searches[1]!.getAttribute('aria-controls'))
    for (const search of searches) {
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      const listbox = document.getElementById(search.getAttribute('aria-controls')!)!
      expect(listbox).toContainElement(document.getElementById(search.getAttribute('aria-activedescendant')!))
    }
  })
})
