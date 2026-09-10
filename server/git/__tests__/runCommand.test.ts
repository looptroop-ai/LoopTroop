import { describe, expect, it } from 'vitest'
import {
  GIT_DEFAULT_TIMEOUT_MS,
  NON_INTERACTIVE_GIT_ENV,
  runCommand,
  runCommandBinarySync,
  runCommandSync,
  runGit,
  runGitBinarySync,
  runGitSync,
} from '../runCommand'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

// Real child processes, no module mocking: the point of these is that the
// runner's guarantees hold against the operating system, not against a stub.
const node = process.execPath

function script(body: string): string[] {
  return ['-e', body]
}

describe('server/git/runCommand', () => {
  it('reports a zero exit as ok with trimmed output', () => {
    const result = runCommandSync(node, script('process.stdout.write("  hello  \\n")'), { log: false })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('hello')
    expect(result.errorDetail).toBeUndefined()
  })

  it('leaves output untouched when trimming is off', () => {
    const result = runCommandSync(node, script('process.stdout.write(" D file.ts\\u0000")'), {
      log: false,
      trimOutput: false,
    })
    // A porcelain record's leading space is data. Trimming it shifts the whole
    // record and takes the first character of the path with it.
    expect(result.stdout).toBe(' D file.ts\u0000')
  })

  it('reports a non-zero exit without throwing, carrying the output as detail', () => {
    const result = runCommandSync(node, script('process.stderr.write("boom"); process.exit(3)'), { log: false })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(3)
    expect(result.errorDetail).toContain('boom')
  })

  it('reports a command that cannot be spawned', () => {
    const result = runCommandSync('looptroop-no-such-binary', ['--version'], { log: false })
    expect(result.ok).toBe(false)
    expect(result.spawnError).toBeDefined()
  })

  it('kills a synchronous command that outlives its timeout, and says so', () => {
    const result = runCommandSync(node, script('setTimeout(() => {}, 60000)'), { timeoutMs: 200, log: false })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.errorDetail).toContain('timed out after 0.2s')
  })

  it('kills an asynchronous command that outlives its timeout', async () => {
    const result = await runCommand(node, script('setTimeout(() => {}, 60000)'), { timeoutMs: 200, log: false })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  it('kills a child that ignores SIGTERM instead of waiting on it forever', async () => {
    const started = Date.now()
    // A timeout that only asks politely is not a timeout: `git` with a
    // credential helper attached, or anything that traps SIGTERM, left the
    // promise pending for as long as the child felt like running.
    const result = await runCommand(
      node,
      script('process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'),
      { timeoutMs: 200, log: false },
    )
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills a SIGTERM-ignoring child on the synchronous path too', () => {
    const started = Date.now()
    const result = runCommandSync(
      node,
      script('process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'),
      { timeoutMs: 200, log: false },
    )
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('does not report a maxBuffer overrun as a timeout', () => {
    const result = runCommandSync(node, script('process.stdout.write("x".repeat(200000))'), {
      maxBuffer: 16,
      log: false,
    })
    expect(result.ok).toBe(false)
    // Both end as SIGTERM with a null status, so only the error code separates
    // them — reporting an overrun as a timeout would send a caller looking for
    // a hung remote that never existed.
    expect(result.timedOut).toBe(false)
  })

  it('enforces maxBuffer on the asynchronous path too', async () => {
    const result = await runCommand(node, script('process.stdout.write("x".repeat(200000))'), {
      maxBuffer: 16,
      log: false,
    })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('applies the non-interactive git environment on both paths', async () => {
    const read = script('process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}:${process.env.GIT_ASKPASS}`)')
    // By absolute path on POSIX: git looks a bare askpass name up on PATH.
    const askpass = process.platform === 'win32' ? 'echo' : '/bin/echo'
    expect(runCommandSync(node, read, { log: false }).stdout).toBe(`0:${askpass}`)
    expect((await runCommand(node, read, { log: false })).stdout).toBe(`0:${askpass}`)
    expect(NON_INTERACTIVE_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('lets a caller add environment on top of the non-interactive pair', () => {
    const result = runCommandSync(
      node,
      script('process.stdout.write(`${process.env.LOOPTROOP_PROBE}:${process.env.GIT_TERMINAL_PROMPT}`)'),
      { env: { LOOPTROOP_PROBE: 'set' }, log: false },
    )
    expect(result.stdout).toBe('set:0')
  })

  it('writes stdin and closes it', async () => {
    const echo = script('let d = ""; process.stdin.on("data", (c) => { d += c }); process.stdin.on("end", () => process.stdout.write(d))')
    expect((await runCommand(node, echo, { input: 'from-stdin', log: false })).stdout).toBe('from-stdin')
    expect(runCommandSync(node, echo, { input: 'from-stdin', log: false }).stdout).toBe('from-stdin')
  })

  it('returns binary stdout undecoded', () => {
    const result = runCommandBinarySync(node, script('process.stdout.write(Buffer.from([0, 159, 146, 150]))'), { log: false })
    expect(Buffer.isBuffer(result.stdout)).toBe(true)
    expect([...result.stdout]).toEqual([0, 159, 146, 150])
  })

  it('defaults to the timeout the established runner used', () => {
    expect(GIT_DEFAULT_TIMEOUT_MS).toBe(30_000)
  })

  it.runIf(process.platform !== 'win32')('resolves the program against the environment the child gets', () => {
    // Resolving against `process.env` while spawning with the caller's `env`
    // let the two disagree: a tool on the caller's PATH alone was reported
    // missing, and a caller that narrowed PATH on purpose had it ignored.
    const root = makeTempDir('run-command-env-')
    try {
      mkdirSync(join(root, 'bin'), { recursive: true })
      writeFileSync(join(root, 'bin', 'only-here'), '#!/bin/sh\necho found\n')
      chmodSync(join(root, 'bin', 'only-here'), 0o755)

      const result = runCommandSync('only-here', [], { env: { PATH: join(root, 'bin') }, log: false })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('found')
    } finally {
      removeTempDir(root)
    }
  })

  it('refuses a git working directory that is not an absolute path, on every git entry point', async () => {
    // `git -C <path>` puts the caller's value straight into git's arguments.
    // A relative one would be read against the daemon's own working directory,
    // and is the only shape that could begin with `-` and be taken as an option.
    // Reported the way a missing git is — never thrown — because every caller
    // already handles a failed git command.
    for (const bad of ['relative/project', '-c', '', `/tmp/with\u0000nul`]) {
      const sync = runGitSync(bad, ['status'], { log: false })
      const binary = runGitBinarySync(bad, ['status'], { log: false })
      const async = await runGit(bad, ['status'], { log: false })
      for (const result of [sync, binary, async]) {
        expect(result.ok).toBe(false)
        expect(result.status).toBeNull()
        expect(result.errorDetail).toMatch(/working directory/)
      }
    }
  })

  it('says a missing working directory is missing, instead of reporting git as not installed', async () => {
    // The directory is git's working directory now, not a `-C` argument, and a
    // spawn into a directory that is not there fails with ENOENT — the same code
    // as a missing git. It is said in LoopTroop's own words, not git's, because
    // git never ran.
    const missing = '/nonexistent/looptroop-project'
    const sync = runGitSync(missing, ['status'], { log: false })
    const async = await runGit(missing, ['status'], { log: false })

    for (const result of [sync, async]) {
      expect(result.ok).toBe(false)
      expect(result.errorDetail).toBe(`git was not started: its working directory ${missing} does not exist or is not a directory.`)
    }
  })
})
