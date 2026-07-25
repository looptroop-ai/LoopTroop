import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GitHookPolicySetting } from '../GitHookPolicySetting'
import { resolveGitHookPolicySetting } from '@/lib/gitHookPolicySetting'
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

  it('resolves ticket, project, then profile precedence', () => {
    expect(resolveGitHookPolicySetting('observe_only', 'use_native_hooks', 'validate_advisory'))
      .toEqual({ policy: 'observe_only', source: 'ticket' })
    expect(resolveGitHookPolicySetting(null, 'use_native_hooks', 'validate_advisory'))
      .toEqual({ policy: 'use_native_hooks', source: 'project' })
    expect(resolveGitHookPolicySetting(null, null, 'validate_advisory'))
      .toEqual({ policy: 'validate_advisory', source: 'profile' })
  })
})
