import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../Toast'
import { useToast } from '../useToast'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('dismisses simultaneous toasts independently and expires the remaining toast', async () => {
  vi.useFakeTimers()
  // Force collisions if timestamp/random IDs are reintroduced.
  vi.spyOn(Date, 'now').mockReturnValue(0)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  function Trigger() {
    const { addToast } = useToast()
    return <button onClick={() => {
      addToast('info', 'First', 1000)
      addToast('info', 'Second', 2000)
    }}>Notify</button>
  }
  render(<ToastProvider><Trigger /></ToastProvider>)
  fireEvent.click(screen.getByText('Notify'))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss First' }))
  expect(screen.queryByText('First')).not.toBeInTheDocument()
  expect(screen.getByText('Second')).toBeInTheDocument()
  await act(() => vi.advanceTimersByTime(2000))
  expect(screen.queryByText('Second')).not.toBeInTheDocument()
})

it('keeps active toasts independently dismissible across ordinary rerenders', () => {
  function Trigger({ message }: { message: string }) {
    const { addToast } = useToast()
    return <button onClick={() => addToast('info', message)}>Notify</button>
  }
  const { rerender } = render(<ToastProvider><Trigger message="Before" /></ToastProvider>)
  fireEvent.click(screen.getByText('Notify'))
  rerender(<ToastProvider><Trigger message="After" /></ToastProvider>)
  fireEvent.click(screen.getByText('Notify'))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss After' }))
  expect(screen.queryByText('After')).not.toBeInTheDocument()
  expect(screen.getByText('Before')).toBeInTheDocument()
})
