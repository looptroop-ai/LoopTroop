import { describe, it, expect, vi } from 'vitest'
import { signInLine } from '../server/cli/daemonProcess'

/**
 * A foreground daemon is the one path that can print a bootstrap URL, and that
 * URL's fragment is a single-use credential for a browser session. `looptroop
 * start --foreground >daemon.log`, a systemd unit and `docker logs` all capture
 * stdout to somewhere far more readable than the config dir's 0600 files.
 */
describe('foreground sign-in line', () => {
  it('prints the link when a person is watching the terminal', () => {
    const line = signInLine(() => 'http://127.0.0.1:4317/#bootstrap=secret-nonce', true)
    expect(line).toContain('http://127.0.0.1:4317/#bootstrap=secret-nonce')
  })

  it('names the command instead of the nonce when stdout is captured', () => {
    const mint = vi.fn(() => 'http://127.0.0.1:4317/#bootstrap=secret-nonce')

    const line = signInLine(mint, false)

    expect(line).not.toContain('secret-nonce')
    expect(line).toContain('looptroop open')
    // Not minted at all: an unshown nonce would still occupy a slot in the
    // bootstrap store until it expired, for a line nobody can read.
    expect(mint).not.toHaveBeenCalled()
  })
})
