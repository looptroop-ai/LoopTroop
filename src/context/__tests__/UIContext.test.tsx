import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
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

  it('normalizes persisted partial filter state from older browser sessions', () => {
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

  it('migrates legacy onlyErrors:true to errorState "blocked"', () => {
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: { onlyErrors: true },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('error-state')).toHaveTextContent('blocked')
  })

  it('drops legacy single-string status filter', () => {
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

  it('migrates legacy looptroop-presets-* keys into presetsByProject', () => {
    localStorage.setItem('looptroop-presets-global', JSON.stringify({
      'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
    }))
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: {},
      presetsByProject: {},
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('preset-scopes')).toHaveTextContent('looptroop-presets-global')
  })

  it('recovers legacy preset keys on every load, even without a durable UI-state record', () => {
    localStorage.setItem('looptroop-presets-global', JSON.stringify({
      'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
    }))

    const { unmount } = render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('preset-scopes')).toHaveTextContent('looptroop-presets-global')

    // A refresh with no user action still shows the preset: the first load wrote the
    // merged blob before retiring the standalone key, so the second load reads it back
    // from the blob.
    unmount()
    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )
    expect(screen.getByTestId('preset-scopes')).toHaveTextContent('looptroop-presets-global')
  })

  it('merges legacy preset keys into an existing persisted preset scope', () => {
    localStorage.setItem('looptroop-presets-global', JSON.stringify({
      'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
    }))
    localStorage.setItem('looptroop-ui-state', JSON.stringify({
      filters: {},
      presetsByProject: {
        'looptroop-presets-global': {
          Existing: { priority: [2], stuckDays: null, errorState: 'none', sortBy: 'updatedAt_desc' },
        },
      },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('global-presets')).toHaveTextContent('Existing')
    expect(screen.getByTestId('global-presets')).toHaveTextContent('Night ops')
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

  it('handles malformed preset keys without aborting migration of valid ones', () => {
    localStorage.setItem('looptroop-presets-malformed', 'not-json')
    localStorage.setItem('looptroop-presets-global', JSON.stringify({
      'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
    }))

    render(
      <UIProvider>
        <UIStateProbe />
      </UIProvider>,
    )

    expect(screen.getByTestId('preset-scopes')).toHaveTextContent('looptroop-presets-global')
  })

  /**
   * The legacy keys were merged on every load and never removed, so the blob could
   * never express a deletion: a preset the user deleted was copied back out of its
   * standalone key on the next load, however many times they deleted it. They are
   * retired now — but only once the merged blob has actually been written, because
   * deleting first and failing to write would destroy the only copy.
   */
  describe('legacy preset keys', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('retires a legacy key once the merged blob is written', () => {
      localStorage.setItem('looptroop-presets-global', JSON.stringify({
        'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
      }))

      render(
        <UIProvider>
          <UIStateProbe />
        </UIProvider>,
      )

      expect(screen.getByTestId('global-presets')).toHaveTextContent('Night ops')
      const stored = JSON.parse(localStorage.getItem('looptroop-ui-state') ?? '{}') as {
        presetsByProject?: Record<string, Record<string, unknown>>
      }
      expect(stored.presetsByProject?.['looptroop-presets-global']).toHaveProperty('Night ops')
      expect(localStorage.getItem('looptroop-presets-global')).toBeNull()
    })

    it('keeps a deleted preset deleted across a reload', () => {
      localStorage.setItem('looptroop-presets-global', JSON.stringify({
        'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
      }))

      const { unmount } = render(
        <UIProvider>
          <PresetDeleteProbe />
        </UIProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Delete presets' }))
      expect(screen.getByTestId('preset-names')).toHaveTextContent('')

      unmount()
      render(
        <UIProvider>
          <UIStateProbe />
        </UIProvider>,
      )

      expect(screen.getByTestId('global-presets')).toHaveTextContent('')
    })

    it('leaves the legacy key in place when the blob cannot be written', () => {
      localStorage.setItem('looptroop-presets-global', JSON.stringify({
        'Night ops': { priority: [1], stuckDays: 3, onlyErrors: true, sortBy: 'priority_asc' },
      }))
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      render(
        <UIProvider>
          <UIStateProbe />
        </UIProvider>,
      )

      expect(screen.getByTestId('global-presets')).toHaveTextContent('Night ops')
      expect(localStorage.getItem('looptroop-presets-global')).not.toBeNull()
    })
  })
})
