import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `server/index.ts` is the package's `main`, so importing it must not start
 * anything. A module-scope `runtime.start()` binds a port and module-scope
 * `process.on('SIGTERM')` hijacks the host's shutdown, both as a side effect of
 * `import('looptroop')` — with no opt-out, and no obvious cause when the port
 * turns out to be taken or a signal never reaches the real handler.
 *
 * Run in a child process because the assertion is about process-wide state:
 * importing inside the vitest worker would install handlers on the worker
 * itself, and a leaked listener there is invisible to an in-process check.
 */
describe('published main entry', () => {
  const repoRoot = resolve(import.meta.dirname, '..')

  function importInChild(): { signalListeners: number; exports: string[] } {
    const dir = mkdtempSync(resolve(tmpdir(), 'looptroop-main-'))
    // `.mts`, not `.ts`: the probe sits outside the repo, so there is no
    // `"type": "module"` above it and tsx would transform a `.ts` file as
    // CommonJS, where the top-level await below is a syntax error.
    const probe = resolve(dir, 'probe.mts')

    writeFileSync(
      probe,
      [
        `const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')`,
        // A URL, not a path: `import('C:\\...')` is ERR_UNSUPPORTED_ESM_URL_SCHEME
        // on Windows, where the drive letter reads as a scheme.
        `const mod = await import(${JSON.stringify(pathToFileURL(resolve(repoRoot, 'server/index.ts')).href)})`,
        `const after = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')`,
        `console.log(JSON.stringify({ signalListeners: after - before, exports: Object.keys(mod).sort() }))`,
      ].join('\n'),
    )

    const stdout = execFileSync(process.execPath, ['--import', 'tsx', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      // A daemon that did start would inherit these and could touch real state.
      env: { ...process.env, LOOPTROOP_CONFIG_DIR: resolve(dir, 'config') },
    })

    const line = stdout.trim().split('\n').at(-1) ?? '{}'
    return JSON.parse(line) as { signalListeners: number; exports: string[] }
  }

  /**
   * The child exiting at all is the other half of the assertion: a module that
   * bound a port would hold the event loop open and be killed by the timeout
   * instead of returning.
   */
  it('imports without binding a port or installing signal handlers', () => {
    expect(importInChild().signalListeners).toBe(0)
  })

  it('still exports the embeddable surface', () => {
    expect(importInChild().exports).toEqual(['createApp', 'createRuntime', 'isLoopbackHost', 'main'])
  })
})
