import { describe, expect, it } from 'vitest'
import {
  GIT_DEFAULT_TIMEOUT_MS,
  NON_INTERACTIVE_GIT_ENV,
  runCommand,
  runCommandBinarySync,
  runCommandSync,
} from '../runCommand'

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
    expect(runCommandSync(node, read, { log: false }).stdout).toBe('0:echo')
    expect((await runCommand(node, read, { log: false })).stdout).toBe('0:echo')
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
})
