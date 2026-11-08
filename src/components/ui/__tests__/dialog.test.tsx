import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

afterEach(cleanup)

function renderDialog(className?: string) {
  render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Test dialog</DialogTitle>
        <div data-testid="dialog-scroll-region" className="min-h-0 flex-1 overflow-y-auto">
          Long dialog content
        </div>
      </DialogContent>
    </Dialog>,
  )
  return screen.getByRole('dialog', { name: 'Test dialog' })
}

describe('DialogContent viewport sizing', () => {
  it('bounds default dialogs and lets long content scroll', () => {
    const dialog = renderDialog()

    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto')
  })

  it('keeps tighter dialog limits and their inner scroll regions', () => {
    const dialog = renderDialog('max-h-[min(80vh,calc(100dvh-2rem))] flex flex-col')

    expect(dialog).toHaveClass('max-h-[min(80vh,calc(100dvh-2rem))]', 'overflow-y-auto', 'flex', 'flex-col')
    expect(dialog).not.toHaveClass('max-h-[calc(100dvh-2rem)]')
    expect(screen.getByTestId('dialog-scroll-region')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
  })
})
