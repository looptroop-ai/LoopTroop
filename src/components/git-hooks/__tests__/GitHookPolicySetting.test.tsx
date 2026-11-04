import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GitHookPolicySetting } from '../GitHookPolicySetting'
import {
  normalizeGitHookPolicySetting,
} from '@/lib/gitHookPolicySetting'
import { TooltipProvider } from '@/components/ui/tooltip'

function renderSetting() {
  const onChange = vi.fn()
  render(
    <TooltipProvider>
      <GitHookPolicySetting
        value={null}
        inheritedPolicy="observe_only"
        onChange={onChange}
      />
    </TooltipProvider>,
  )
  return onChange
}

describe('GitHookPolicySetting', () => {
  it('shows the inherited policy as one of four simple choices', () => {
    const onChange = renderSetting()

    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(screen.getByRole('radio', { name: 'Observe' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Observe' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByText(/Inherited default is selected/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Check' }))
    expect(onChange).toHaveBeenCalledWith('validate_advisory')
  })

  it.each([
    ['Observe', 'does not run separate validation commands'],
    ['Check', 'does not block the ticket'],
    ['Require', 'blocks the ticket'],
    ['Run', 'A hook can block or modify those operations'],
  ])('explains the %s choice on hover', async (label, expectedText) => {
    renderSetting()
    fireEvent.focus(screen.getByRole('radio', { name: label }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(expectedText)
  })

  it('keeps a known policy and rejects anything else', () => {
    expect(normalizeGitHookPolicySetting('validate_required')).toBe('validate_required')
    expect(normalizeGitHookPolicySetting('validate_explicitly')).toBeNull()
    expect(normalizeGitHookPolicySetting('constructor')).toBeNull()
    expect(normalizeGitHookPolicySetting('unknown')).toBeNull()
  })
})
