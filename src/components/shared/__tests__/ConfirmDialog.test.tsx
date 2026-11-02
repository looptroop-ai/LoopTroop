import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmDialogHost } from '../ConfirmDialog'
import { alertDialog, confirmDialog } from '@/lib/confirmDialog'

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
})
