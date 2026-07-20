import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EffortPicker } from '../EffortPicker'

const variants = {
  low: { reasoningEffort: 'low' },
  high: { reasoningEffort: 'high' },
}

function renderPicker(value: string | undefined, onChange = vi.fn()) {
  render(
    <TooltipProvider>
      <EffortPicker variants={variants} value={value} onChange={onChange} />
    </TooltipProvider>,
  )
  return onChange
}

describe('EffortPicker', () => {
  it('prepends None and selects it when no effort override is set', () => {
    renderPicker(undefined)

    const buttons = screen.getAllByRole('button')
    expect(buttons.map(button => button.textContent)).toEqual(['○None', '◑Low', '●High'])
    expect(screen.getByRole('button', { name: '○None' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('treats a legacy none value as the selected unset state', () => {
    renderPicker('none')

    expect(screen.getByRole('button', { name: '○None' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('emits named efforts and clears the override when None is selected', () => {
    const onChange = renderPicker(undefined)

    fireEvent.click(screen.getByRole('button', { name: '◑Low' }))
    fireEvent.click(screen.getByRole('button', { name: '○None' }))

    expect(onChange).toHaveBeenNthCalledWith(1, 'low')
    expect(onChange).toHaveBeenNthCalledWith(2, undefined)
  })
})
