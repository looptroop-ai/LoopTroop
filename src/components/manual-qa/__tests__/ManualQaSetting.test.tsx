import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ManualQaSetting } from '../ManualQaSetting'
import { resolveManualQaSettingLabel } from '@/lib/manualQaSetting'
import { TooltipProvider } from '@/components/ui/tooltip'

function renderSetting() {
  const onChange = vi.fn()
  render(
    <TooltipProvider>
      <ManualQaSetting idPrefix="qa" value={null} onChange={onChange} inheritedEnabled />
    </TooltipProvider>,
  )
  return onChange
}

describe('ManualQaSetting', () => {
  it('offers only enabled and disabled while resolving legacy defaults', () => {
    const onChange = renderSetting()

    expect(screen.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('radio', { name: 'Enabled' }).className).toContain('bg-primary')
    expect(screen.getByText(/Current default:/)).toHaveTextContent('Enabled')
    fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it.each([
    ['Enabled', 'generates a checklist and pauses the ticket for your review'],
    ['Disabled', 'proceeds directly to integration without a Manual QA checkpoint'],
  ])('explains the %s choice on hover', async (label, expectedText) => {
    renderSetting()
    fireEvent.focus(screen.getByRole('radio', { name: label }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(expectedText)
  })

  it('resolves ticket, project, then global precedence', () => {
    expect(resolveManualQaSettingLabel(false, true, true)).toEqual({ enabled: false, source: 'ticket' })
    expect(resolveManualQaSettingLabel(null, true, false)).toEqual({ enabled: true, source: 'project' })
    expect(resolveManualQaSettingLabel(null, null, true)).toEqual({ enabled: true, source: 'profile' })
  })
})
