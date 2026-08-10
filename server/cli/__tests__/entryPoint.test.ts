import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve, sep } from 'node:path'
import { isEntryPoint } from '../entryPoint'

/**
 * The detached daemon is spawned as `node <abs path>/daemonProcess.js`, so this
 * predicate decides whether the child does any work at all. A false negative is
 * invisible: the child exits 0 having run nothing, and `start` blames a timeout.
 */
describe('isEntryPoint', () => {
  const modulePath = resolve('/tmp/looptroop/dist/server/cli/daemonProcess.js')
  const moduleUrl = pathToFileURL(modulePath).href

  it('matches the path Node was asked to run', () => {
    expect(isEntryPoint(moduleUrl, modulePath)).toBe(true)
  })

  it('matches when the URL is percent-encoded and the argument is not', () => {
    // npm installs into "Program Files" on Windows and into paths with spaces
    // on macOS often enough that this is the common case, not an edge one.
    const spaced = resolve(`${sep}tmp`, 'loop troop', 'daemonProcess.js')
    expect(pathToFileURL(spaced).href).toContain('%20')
    expect(isEntryPoint(pathToFileURL(spaced).href, spaced)).toBe(true)
  })

  it('does not match a different file in the same directory', () => {
    expect(isEntryPoint(moduleUrl, resolve('/tmp/looptroop/dist/server/cli/cli.js'))).toBe(false)
  })

  it('does not match when the module was imported rather than executed', () => {
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false)
    expect(isEntryPoint(moduleUrl, '')).toBe(false)
  })

  it('rejects a module URL that is not a file URL', () => {
    expect(isEntryPoint('https://example.com/daemonProcess.js', modulePath)).toBe(false)
    expect(isEntryPoint('data:text/javascript,0', modulePath)).toBe(false)
  })

  /**
   * The regression itself. The old comparison built a URL by string
   * concatenation, which happens to work on POSIX and cannot work on Windows.
   * Asserting the shapes differ keeps anyone from "simplifying" back to it.
   */
  it('does not depend on a hand-built file:// URL matching argv', () => {
    const windowsUrl = 'file:///C:/Program%20Files/looptroop/daemonProcess.js'
    const windowsArgv = 'C:\\Program Files\\looptroop\\daemonProcess.js'
    expect(windowsUrl).not.toBe(`file://${windowsArgv}`)
  })
})
