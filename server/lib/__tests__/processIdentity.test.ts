import { describe, expect, it } from 'vitest'
import { matchProcess, readProcessStartToken, type ProcessIdentityDeps } from '../processIdentity'

/**
 * A /proc/<pid>/stat line with `startTime` at field 22, where the kernel puts it.
 *
 * Fields 1 and 2 are the pid and the executable name; field 3 is the state, and
 * everything the parser sees begins there. The filler is numbered so a
 * miscounted offset shows up as a recognisable value rather than a passing test.
 */
function statLine(comm: string, startTime: number | string): string {
  // Fields 4..21: eighteen values between the state and the start time.
  const between = Array.from({ length: 18 }, (_unused, index) => index + 4).join(' ')
  return `4242 (${comm}) S ${between} ${startTime} 0 0 0\n`
}

function linuxDeps(entries: Record<string, string>): ProcessIdentityDeps {
  return {
    platform: 'linux',
    readTextFile: (path) => entries[path] ?? null,
    runCommand: () => null,
  }
}

function linuxProcess(pid: number, comm: string, startTime: number | string, bootId = 'boot-1'): ProcessIdentityDeps {
  return linuxDeps({
    [`/proc/${pid}/stat`]: statLine(comm, startTime),
    '/proc/sys/kernel/random/boot_id': `${bootId}\n`,
  })
}

describe('readProcessStartToken', () => {
  it('hashes the Linux identity rather than returning it', () => {
    const token = readProcessStartToken(1234, linuxProcess(1234, 'node', 495_600))

    expect(token).toMatch(/^[0-9a-f]{32}$/)
    // The boot id and start time must not be recoverable from what callers print.
    expect(token).not.toContain('495600')
    expect(token).not.toContain('boot-1')
  })

  it('is stable across reads of the same process', () => {
    const deps = linuxProcess(9, 'node', 42)

    expect(readProcessStartToken(9, deps)).toBe(readProcessStartToken(9, deps))
  })

  it('separates two processes that differ only by start time', () => {
    const first = readProcessStartToken(7, linuxProcess(7, 'node', 999))
    const second = readProcessStartToken(7, linuxProcess(7, 'node', 998))

    expect(first).not.toBe(second)
  })

  it('parses past an executable name containing spaces and parentheses', () => {
    const awkward = readProcessStartToken(7, linuxProcess(7, 'bash (with) parens', 999))
    const plain = readProcessStartToken(7, linuxProcess(7, 'node', 999))

    // Same pid, same start time: only the name differs, and the name is not
    // part of the identity, so a correctly parsed line yields the same token.
    expect(awkward).toBe(plain)
  })

  it('separates the same pid and start time across a reboot', () => {
    const before = readProcessStartToken(7, linuxProcess(7, 'node', 100, 'boot-before'))
    const after = readProcessStartToken(7, linuxProcess(7, 'node', 100, 'boot-after'))

    expect(before).not.toBe(after)
  })

  it('returns null when the process is gone', () => {
    expect(readProcessStartToken(404, linuxDeps({}))).toBeNull()
  })

  it('returns null for a pid that addresses a process group', () => {
    const deps = linuxProcess(1, 'init', 1)

    expect(readProcessStartToken(0, deps)).toBeNull()
    expect(readProcessStartToken(-5, deps)).toBeNull()
  })

  it('returns null for a stat line it cannot parse', () => {
    const deps = linuxDeps({
      '/proc/8/stat': 'truncated garbage with no parenthesis',
      '/proc/sys/kernel/random/boot_id': 'boot-1\n',
    })

    expect(readProcessStartToken(8, deps)).toBeNull()
  })

  it('reads the Darwin identity from ps lstart', () => {
    const deps: ProcessIdentityDeps = {
      platform: 'darwin',
      readTextFile: () => null,
      runCommand: (file, args) =>
        file === 'ps' && args.includes('-p') ? 'Tue Aug  4 10:00:00 2026' : null,
    }

    expect(readProcessStartToken(55, deps)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('reads the Windows identity from the PowerShell start time', () => {
    const deps: ProcessIdentityDeps = {
      platform: 'win32',
      readTextFile: () => null,
      runCommand: (file, args) =>
        file === 'powershell.exe' && args.some((arg) => arg.includes('Get-Process'))
          ? '133850000000000000'
          : null,
    }

    expect(readProcessStartToken(55, deps)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('treats a non-numeric Windows answer as no answer', () => {
    const deps: ProcessIdentityDeps = {
      platform: 'win32',
      readTextFile: () => null,
      runCommand: () => 'Get-Process : Cannot find a process with the process identifier 55.',
    }

    expect(readProcessStartToken(55, deps)).toBeNull()
  })
})

describe('matchProcess', () => {
  it('matches a process that is still the one recorded', () => {
    const deps = linuxProcess(123, 'node', 111)
    const token = readProcessStartToken(123, deps)

    expect(matchProcess(123, token ?? undefined, deps)).toEqual({ kind: 'same' })
  })

  it('reports a recycled pid as a different process', () => {
    const recorded = readProcessStartToken(123, linuxProcess(123, 'opencode', 111))
    // The recorded process exited and something else was given its number.
    const now = linuxProcess(123, 'someone-elses-work', 222)

    expect(matchProcess(123, recorded ?? undefined, now)).toEqual({ kind: 'different' })
  })

  it('reports unknown when no token was recorded', () => {
    const match = matchProcess(9, undefined, linuxProcess(9, 'node', 111))

    expect(match.kind).toBe('unknown')
    expect(match.kind === 'unknown' ? match.reason : '').toContain('no start-identity token')
  })

  it('reports unknown for an empty recorded token', () => {
    expect(matchProcess(9, '', linuxProcess(9, 'node', 111)).kind).toBe('unknown')
  })

  it('reports unknown when nothing can be read about the pid', () => {
    const token = readProcessStartToken(9, linuxProcess(9, 'node', 111))

    // A platform that cannot answer must not be mistaken for a match.
    expect(matchProcess(9, token ?? undefined, linuxDeps({})).kind).toBe('unknown')
  })
})
