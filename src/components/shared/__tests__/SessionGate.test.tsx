import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SessionGate } from '../SessionGate'
import { __sessionStateForTests, reportSignedOut } from '@/lib/sessionState'

/**
 * 2.14 contract: once the daemon refuses this browser's session, the app is
 * replaced by an explanation and a remedy — not left mounted with every query
 * failing behind a screen of spinners.
 */
describe('SessionGate', () => {
  beforeEach(() => {
    __sessionStateForTests.reset()
  })

  afterEach(() => {
    __sessionStateForTests.reset()
  })

  it('renders the app while the session holds', () => {
    render(<SessionGate><p>workspace</p></SessionGate>)

    expect(screen.getByText('workspace')).toBeInTheDocument()
    expect(screen.queryByText('Signed out')).not.toBeInTheDocument()
  })

  it('swaps the app for the signed-out screen when the session ends', () => {
    render(<SessionGate><p>workspace</p></SessionGate>)

    act(() => { reportSignedOut() })

    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
    expect(screen.getByText('Signed out')).toBeInTheDocument()
  })

  it('renders the signed-out screen immediately when the session was already gone', () => {
    reportSignedOut()

    render(<SessionGate><p>workspace</p></SessionGate>)

    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
  })

  it('names the command that signs in again, and never a sign-in link', () => {
    render(<SessionGate><p>workspace</p></SessionGate>)
    act(() => { reportSignedOut() })

    expect(screen.getByText('looptroop open')).toBeInTheDocument()
    // The sign-in URL carries a single-use nonce. A screen that printed one would
    // put a live credential on display, and in any screenshot of it.
    expect(document.body.textContent).not.toMatch(/https?:\/\//)
    expect(document.body.textContent).not.toMatch(/bootstrap=/)
  })
})
