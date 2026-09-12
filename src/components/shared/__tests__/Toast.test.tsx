import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../Toast'
import { useToast } from '../useToast'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('dismisses simultaneous toasts independently and expires the remaining toast', () => {
  vi.useFakeTimers()
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
  fireEvent.click(screen.getByText('First').parentElement!.querySelector('button')!)
  expect(screen.queryByText('First')).not.toBeInTheDocument()
  expect(screen.getByText('Second')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.queryByText('Second')).not.toBeInTheDocument()
})
