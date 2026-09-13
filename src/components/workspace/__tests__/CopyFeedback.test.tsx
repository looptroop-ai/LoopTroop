import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppCrashScreen } from '@/components/shared/AppCrashScreen'
import { SignedOutScreen } from '@/components/shared/SignedOutScreen'
import { TooltipProvider } from '@/components/ui/tooltip'
import { normalizeLogRecord } from '@/context/logUtils'
import { CopyButton } from '../RawTextDisplay'
import { TextCopyButton } from '../artifactViewers/TextCopyButton'
import { LogEntryRow } from '../LogLine'

afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard') })

describe('copy failure feedback', () => {
  it.each(['short row', 'long\nrow\nwith\nsix\ntext\nlines'])('keeps failure on the same log identity after status changes: %s', async content => {
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied.'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const entry = normalizeLogRecord({ entryId: 'stable-row', content, phaseAttempt: 1 }, 'CODING')
    const { rerender } = render(<LogEntryRow entry={entry} index={0} showModelName={false} />)
    const button = screen.getByRole('button', { name: 'Copy log entry' })
    expect(button).toHaveClass('focus:opacity-100')
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    expect(button).toHaveAttribute('data-copy-failed', 'true')
    expect(button).toHaveClass('data-[copy-failed]:opacity-100')

    rerender(<LogEntryRow entry={{ ...entry, status: 'FINAL_TESTING' }} index={0} showModelName={false} />)
    expect(screen.getByRole('alert')).toBe(alert)
    expect(screen.getByRole('button', { name: 'Copy log entry' })).toHaveAttribute('data-copy-failed', 'true')

    rerender(<LogEntryRow entry={{ ...entry, entryId: 'different-row' }} index={0} showModelName={false} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy log entry' })).not.toHaveAttribute('data-copy-failed')
  })

  it.each([
    ['raw output', <CopyButton content="example" />, 'Copy raw output'],
    ['artifact text', <TextCopyButton content="example" title="Copy artifact" />, 'Copy artifact'],
    ['sign-in command', <SignedOutScreen />, 'Copy'],
    ['crash details', <AppCrashScreen error={new Error('example')} componentStack="test stack" />, 'Copy details'],
    ['log entry', <LogEntryRow entry={normalizeLogRecord({ line: 'example' }, 'CODING')} index={0} showModelName={false} />, 'Copy log entry'],
  ] as const)('shows a failure for %s and clears it after retry succeeds', async (_label, component, buttonName) => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('Write permission denied.'))
      .mockRejectedValueOnce(new Error('Write permission denied.'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<TooltipProvider>{component}</TooltipProvider>)

    if (buttonName === 'Copy details') fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    const button = screen.getByRole('button', { name: buttonName })
    fireEvent.click(button)
    const firstAlert = await screen.findByRole('alert')
    expect(firstAlert).toHaveTextContent('Copy failed')
    fireEvent.click(button)
    await waitFor(() => { expect(screen.getByRole('alert')).not.toBe(firstAlert) })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument() })
    expect(writeText).toHaveBeenCalledTimes(3)
  })
})
