import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { UIProvider } from '../UIContext'
import { useUI } from '../useUI'

function UIStateProbe() {
  const { state } = useUI()
  const presetScopes = Object.keys(state.presetsByProject)
  const globalPresetNames = Object.keys(state.presetsByProject['looptroop-presets-global'] ?? {})

  return (
    <div>
      <span data-testid="search">{state.filters.search}</span>
      <span data-testid="project-filter">{state.filters.projectId ?? 'none'}</span>
      <span data-testid="error-state">{state.filters.errorState}</span>
      <span data-testid="status-filter">{state.filters.status?.join(',') ?? 'none'}</span>
      <span data-testid="phase-filter">{state.filters.phase?.join(',') ?? 'none'}</span>
      <span data-testid="preset-scopes">{presetScopes.join('|')}</span>
      <span data-testid="global-presets">{globalPresetNames.join('|')}</span>
    </div>
  )
}

function TicketSelectionProbe() {
  const { state, dispatch } = useUI()

  return (
    <div>
      <span data-testid="active-view">{state.activeView}</span>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SELECT_TICKET', ticketId: 'ticket-1', externalId: 'LT-1' })}
      >
        Select ticket
      </button>
      <button type="button" onClick={() => dispatch({ type: 'CLOSE_TICKET' })}>Close ticket</button>
    </div>
  )
}

function PresetDispatchProbe() {
  const { state, dispatch } = useUI()
  const presetNames = Object.keys(state.presetsByProject['looptroop-presets-global'] ?? {})

  return (
    <div>
      <button
        type="button"
        onClick={() => dispatch({
          type: 'SET_PRESETS',
          presetKey: 'looptroop-presets-global',
          presets: {
            'Night ops': {
              priority: [1],
              stuckDays: 3,
              status: ['CODING'],
              phase: null,
              errorState: 'blocked',
              sortBy: 'priority_asc',
              showMocks: true,
            },
          },
        })}
      >
        Save preset
      </button>
      <span data-testid="preset-names">{presetNames.join('|')}</span>
    </div>
  )
}

function PresetDeleteProbe() {
  const { state, dispatch } = useUI()
  const presetNames = Object.keys(state.presetsByProject['looptroop-presets-global'] ?? {})

  return (
    <div>
      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_PRESETS', presetKey: 'looptroop-presets-global', presets: {} })}
      >
        Delete presets
      </button>
      <span data-testid="preset-names">{presetNames.join('|')}</span>
    </div>
  )
}

function ThemeDispatchProbe() {
  const { dispatch } = useUI()
  return (
    <button type="button" onClick={() => dispatch({ type: 'SET_THEME', theme: 'dark' })}>
      Set dark
    </button>
  )
}

describe('UIProvider', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('fills filter fields missing from the saved state with defaults', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      activeView: 'kanban',
      filters: {
        projectId: 7,
      },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('search')).toHaveTextContent('')
    expect(screen.getByTestId('project-filter')).toHaveTextContent('7')
    expect(screen.getByTestId('error-state')).toHaveTextContent('none')
  })

  it('ignores filter fields it does not know', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: { onlyErrors: true },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('error-state')).toHaveTextContent('none')
  })

  it('drops a status filter that is not a list', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: { status: 'CODING' },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('status-filter')).toHaveTextContent('none')
  })

  it('keeps a deleted preset deleted across a reload', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: {},
      presetsByProject: {
        'looptroop-presets-global': {
          'Night ops': { priority: [1], stuckDays: 3, errorState: 'blocked', sortBy: 'priority_asc' },
        },
      },
    }))

    const { unmount } = render(
      <UIProvider>
        <PresetDeleteProbe />
      </UIProvider>,
    )
    expect(screen.getByTestId('preset-names')).toHaveTextContent('Night ops')
    fireEvent.click(screen.getByRole('button', { name: 'Delete presets' }))

    unmount()
    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('global-presets')).toHaveTextContent('')
  })

  it('reads presets only from the saved UI state, not from standalone keys', () => {
    localStorage.setItem('looptroop-presets-global', JSON.stringify({
      'Night ops': { priority: [1], stuckDays: 3, errorState: 'blocked', sortBy: 'priority_asc' },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('preset-scopes')).toHaveTextContent('')
  })

  it('keeps valid presets when unrelated persisted UI fields are invalid', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      activeView: 'missing-view',
      logPanelHeight: 20,
      filters: { search: 42 },
      presetsByProject: {
        'looptroop-presets-global': {
          'Night ops': { priority: [1], stuckDays: 3, errorState: 'blocked', sortBy: 'priority_asc' },
        },
      },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('global-presets')).toHaveTextContent('Night ops')
    expect(screen.getByTestId('search')).toHaveTextContent('')
  })

  it('persists the whole committed state (presets included) on an unrelated UI update', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: {},
      presetsByProject: {
        'looptroop-presets-global': {
          'Night ops': { priority: [1], stuckDays: 3, errorState: 'blocked', sortBy: 'priority_asc' },
        },
      },
    }))

    render(
      <UIProvider>
        <ThemeDispatchProbe />
      </UIProvider>,
    )

    // An unrelated dispatch persists React state, which already carries the loaded presets.
    fireEvent.click(screen.getByRole('button', { name: 'Set dark' }))

    const stored = JSON.parse(localStorage.getItem('looptroop-ui-state') ?? '{}') as {
      theme?: string
      presetsByProject?: Record<string, Record<string, unknown>>
    }
    expect(stored.theme).toBe('dark')
    expect(stored.presetsByProject?.['looptroop-presets-global']).toHaveProperty('Night ops')
  })

  it('persists saved presets through a fresh provider boot', () => {
    const { unmount } = render(
      <UIProvider>
        <PresetDispatchProbe />
      </UIProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }))

    const stored = JSON.parse(localStorage.getItem('looptroop-ui-state') ?? '{}') as {
      presetsByProject?: Record<string, Record<string, unknown>>
    }
    expect(stored.presetsByProject?.['looptroop-presets-global']).toHaveProperty('Night ops')

    unmount()
    render(
      <UIProvider>
        <PresetDispatchProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('preset-names')).toHaveTextContent('Night ops')
  })

  /**
   * `App` is the sole owner of the URL. This provider used to push a pathname
   * of its own derived from `activeView`, which rewrote whatever route `App`
   * had opened. Nothing here may write history again.
   */
  describe('URL ownership', () => {
    it('never writes history, on mount or when the selection changes', () => {
      const pushState = vi.spyOn(window.history, 'pushState')
      const replaceState = vi.spyOn(window.history, 'replaceState')

      render(
        <UIProvider>
          <TicketSelectionProbe />
        </UIProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Select ticket' }))
      expect(screen.getByTestId('active-view')).toHaveTextContent('ticket')
      fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }))
      expect(screen.getByTestId('active-view')).toHaveTextContent('kanban')

      expect(pushState).not.toHaveBeenCalled()
      expect(replaceState).not.toHaveBeenCalled()
    })
  })
})
