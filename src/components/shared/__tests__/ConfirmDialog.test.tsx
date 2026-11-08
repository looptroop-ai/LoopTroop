import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmDialogHost } from '../ConfirmDialog'
import { alertDialog, cancelConfirmQuestions, confirmDialog } from '@/lib/confirmDialog'
import { CONFIRM_DIALOG_Z_INDEX, DROPDOWN_Z_INDEX, SHORTCUTS_OVERLAY_Z_INDEX } from '@/lib/constants'

afterEach(cleanup)

const QUESTION = { title: 'Discard unsaved changes?', message: 'They are not saved yet.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' as const }

describe('confirmDialog', () => {
  it('resolves true on confirm and false on cancel', async () => {
    render(<ConfirmDialogHost />)

    const yes = confirmDialog(QUESTION)
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })
    expect(dialog).toHaveAccessibleDescription('They are not saved yet.')
    // The safe answer gets focus, so a stray Enter does not throw work away.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await expect(yes).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    const no = confirmDialog(QUESTION)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
    await expect(no).resolves.toBe(false)
  })

  it('treats Escape and the close button as cancel', async () => {
    render(<ConfirmDialogHost />)

    const escaped = confirmDialog(QUESTION)
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' })
    await expect(escaped).resolves.toBe(false)

    const closed = confirmDialog(QUESTION)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await expect(closed).resolves.toBe(false)
  })

  it('answers an older question with false when a newer one replaces it', async () => {
    render(<ConfirmDialogHost />)

    const first = confirmDialog({ title: 'First?', message: 'one' })
    await screen.findByRole('alertdialog', { name: 'First?' })
    const second = confirmDialog({ title: 'Second?', message: 'two' })

    await expect(first).resolves.toBe(false)
    expect(await screen.findByRole('alertdialog', { name: 'Second?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await expect(second).resolves.toBe(true)
  })

  it('shows an alert with a single button that settles however it is dismissed', async () => {
    render(<ConfirmDialogHost />)

    const done = alertDialog({ title: 'Could not start', message: 'model unavailable' })
    await screen.findByRole('alertdialog', { name: 'Could not start' })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await expect(done).resolves.toBeUndefined()
  })

  it('moves focus to the safe button when a newer question replaces an open one', async () => {
    render(<ConfirmDialogHost />)

    void confirmDialog({ title: 'First?', message: 'one', confirmLabel: 'Go' })
    const go = await screen.findByRole('button', { name: 'Go' })
    go.focus()
    void confirmDialog({ ...QUESTION, title: 'Second?' })

    await screen.findByRole('alertdialog', { name: 'Second?' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  })

  it('keeps an alert on screen until it is dismissed, then shows the question that came after it', async () => {
    render(<ConfirmDialogHost />)

    const alerted = alertDialog({ title: 'Could not start', message: 'model unavailable' })
    await screen.findByRole('alertdialog', { name: 'Could not start' })
    const asked = confirmDialog(QUESTION)
    cancelConfirmQuestions()
    await expect(asked).resolves.toBe(false)

    const askedAgain = confirmDialog(QUESTION)
    expect(screen.getByRole('alertdialog', { name: 'Could not start' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await expect(alerted).resolves.toBeUndefined()

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await expect(askedAgain).resolves.toBe(true)
  })

  it('returns focus to whatever had it when the question was asked', async () => {
    render(<><button type="button">Close window</button><ConfirmDialogHost /></>)
    const opener = screen.getByRole('button', { name: 'Close window' })
    opener.focus()

    const answer = confirmDialog(QUESTION)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
    await expect(answer).resolves.toBe(false)
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('sits above the pickers and the shortcuts overlay', async () => {
    render(<ConfirmDialogHost />)
    void confirmDialog(QUESTION)
    const dialog = await screen.findByRole('alertdialog')

    expect(CONFIRM_DIALOG_Z_INDEX).toBeGreaterThan(Math.max(DROPDOWN_Z_INDEX, SHORTCUTS_OVERLAY_Z_INDEX))
    expect(dialog.style.zIndex).toBe(String(CONFIRM_DIALOG_Z_INDEX))
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  })

  it('keeps a long message in one scroll region and leaves the title and answers fixed', async () => {
    render(<ConfirmDialogHost />)
    const message = 'This message needs room to scroll. '.repeat(40)
    act(() => { void alertDialog({ title: 'Long message', message }) })

    const dialog = await screen.findByRole('alertdialog', { name: 'Long message' })
    const [header, body, footer] = Array.from(dialog.children)
    if (!(header instanceof HTMLElement) || !(body instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
      throw new Error('Confirmation dialog is missing its header, message, or answers.')
    }

    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'flex', 'flex-col', 'overflow-y-auto')
    expect(header).toHaveClass('shrink-0')
    expect(body).toHaveClass('min-h-24', 'flex-1', 'overflow-y-auto')
    expect(body).toHaveAttribute('tabindex', '0')
    expect(footer).toHaveClass('shrink-0')
    expect(body.textContent).toBe(message)
    expect(footer).toContainElement(screen.getByRole('button', { name: 'OK' }))
  })

  it('settles everything when the host unmounts, so nothing awaits forever or comes back', async () => {
    const view = render(<ConfirmDialogHost />)
    const asked = confirmDialog(QUESTION)
    await screen.findByRole('alertdialog')
    view.unmount()
    await expect(asked).resolves.toBe(false)

    render(<ConfirmDialogHost />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
