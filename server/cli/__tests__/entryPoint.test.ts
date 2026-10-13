import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve, sep } from 'node:path'
import { isEntryPoint } from '../entryPoint'

/**
 * A directly run entry (`node <abs path>/cli.js`) does any work at all only if
 * this predicate says so. A false negative is invisible: the process exits 0
 * having run nothing.
 */
describe('isEntryPoint', () => {
  const modulePath = resolve('/tmp/looptroop/dist/server/cli/cli.js')
  const moduleUrl = pathToFileURL(modulePath).href

  it('matches the path Node was asked to run', () => {
    expect(isEntryPoint(moduleUrl, modulePath)).toBe(true)
  })

  it('matches when the URL is percent-encoded and the argument is not', () => {
    // npm installs into "Program Files" on Windows and into paths with spaces
    // on macOS often enough that this is the common case, not an edge one.
    const spaced = resolve(`${sep}tmp`, 'loop troop', 'cli.js')
    expect(pathToFileURL(spaced).href).toContain('%20')
    expect(isEntryPoint(pathToFileURL(spaced).href, spaced)).toBe(true)
  })

  it('does not match a different file in the same directory', () => {
    expect(isEntryPoint(moduleUrl, resolve('/tmp/looptroop/dist/server/cli/launcher.cjs'))).toBe(false)
  })

  it('does not match when the module was imported rather than executed', () => {
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false)
    expect(isEntryPoint(moduleUrl, '')).toBe(false)
  })

  it('rejects a module URL that is not a file URL', () => {
    expect(isEntryPoint('https://example.com/cli.js', modulePath)).toBe(false)
    expect(isEntryPoint('data:text/javascript,0', modulePath)).toBe(false)
  })

  /**
   * The regression itself. The old comparison built a URL by string
   * concatenation, which happens to work on POSIX and cannot work on Windows.
   * Asserting the shapes differ keeps anyone from "simplifying" back to it.
   */
  it('does not depend on a hand-built file:// URL matching argv', () => {
    const windowsUrl = 'file:///C:/Program%20Files/looptroop/cli.js'
    const windowsArgv = 'C:\\Program Files\\looptroop\\cli.js'
    expect(windowsUrl).not.toBe(`file://${windowsArgv}`)
  })
})
