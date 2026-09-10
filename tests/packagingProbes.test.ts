import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, win32 } from 'node:path'
import { claimTapDirectory, isOwnedTap } from '../scripts/brew-local-tap.ts'
import { defaultTrustedPrefixes, resolveTrustedTool } from '../scripts/trusted-tool.ts'
import { quoteArgForShell, quoteProgramForShell, shellCommandLine, spawnProgram } from '../scripts/tool-path.ts'
import { withoutCredentials } from '../scripts/container-docker.ts'
import { removeWorkDirectory, waitForHealth } from '../scripts/smoke-lib.mjs'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) removeTempDir(dir)
})

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-tap-test-'))
  scratch.push(dir)
  return dir
}

/**
 * The throwaway tap is built by deleting the directory it is about to occupy,
 * and torn down by deleting it again. Both are right for a tap this script
 * created and destructive for anything else — a developer who happens to have
 * tapped a repository under the same name lost it, with nothing asked and
 * nothing said.
 */
describe('throwaway Homebrew tap', () => {
  it('creates a marked, empty tap where there was nothing', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')

    claimTapDirectory(directory)

    expect(existsSync(join(directory, 'Formula'))).toBe(true)
    expect(isOwnedTap(directory)).toBe(true)
  })

  it('replaces a tap an earlier run of this script left behind', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')
    claimTapDirectory(directory)
    writeFileSync(join(directory, 'Formula', 'looptroop.rb'), 'stale')

    claimTapDirectory(directory)

    expect(existsSync(join(directory, 'Formula', 'looptroop.rb'))).toBe(false)
    expect(isOwnedTap(directory)).toBe(true)
  })

  it('refuses a tap it did not create, and does not touch it', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')
    mkdirSync(join(directory, 'Formula'), { recursive: true })
    writeFileSync(join(directory, 'Formula', 'somebody-elses.rb'), 'a real formula')

    expect(() => claimTapDirectory(directory)).toThrow(/was not created by this script/)
    expect(readFileSync(join(directory, 'Formula', 'somebody-elses.rb'), 'utf8')).toBe('a real formula')
  })

  it('says a directory that does not exist is not one of ours', () => {
    expect(isOwnedTap(join(freshDir(), 'nothing-here'))).toBe(false)
  })
})

/**
 * The anonymous container check asks whether a client with no credentials can
 * pull the release. It used to establish that with `docker logout`, whose
 * result it ignored — so a logout that failed left the check authenticated,
 * which is exactly the state that makes a private repository pass.
 */
describe('anonymous Docker configuration', () => {
  it('removes credentials stored directly', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      auths: { 'https://index.docker.io/v1/': { auth: 'c2VjcmV0' } },
    })))

    expect(stripped.auths).toBeUndefined()
  })

  /**
   * The half that removing `auths` alone would miss: these name external
   * programs that hand credentials back on demand, so a config with no `auths`
   * at all can still authenticate.
   */
  it('removes the credential helpers as well', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      credsStore: 'desktop',
      credHelpers: { 'ghcr.io': 'gh' },
    })))

    expect(stripped.credsStore).toBeUndefined()
    expect(stripped.credHelpers).toBeUndefined()
  })

  /**
   * Everything else is kept. An empty config would lose the buildx builder
   * configuration and fail the check for a reason that has nothing to do with
   * whether the image is public.
   */
  it('keeps everything that is not a credential', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      auths: { 'ghcr.io': { auth: 'c2VjcmV0' } },
      currentContext: 'default',
      aliases: { builder: 'buildx' },
    })))

    expect(stripped.currentContext).toBe('default')
    expect(stripped.aliases).toEqual({ builder: 'buildx' })
  })

  it('reduces an unreadable config to an empty one rather than passing it through', () => {
    expect(JSON.parse(withoutCredentials('not json at all'))).toEqual({})
  })
})

/**
 * Three smoke scripts had their own `waitForHealth` and four had their own
 * retry-and-never-throw removal. Sharing them is only safe if the shared one
 * keeps every property each copy relied on, so those are what is asserted here
 * rather than that the function exists.
 */
describe('shared smoke helpers', () => {
  it('returns the health payload as soon as the daemon answers', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', instanceId: 'abc' }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo

    try {
      expect(await waitForHealth(`http://127.0.0.1:${port}`, 5_000))
        .toEqual({ status: 'ok', instanceId: 'abc' })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('gives up and returns null rather than throwing when nothing is listening', async () => {
    // Port 1 needs privileges to bind and nothing holds it, so the connection
    // is refused immediately and this exercises the catch on every attempt.
    const started = Date.now()

    expect(await waitForHealth('http://127.0.0.1:1', 400)).toBeNull()
    // Bounded by the timeout it was given, not by a default of its own.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  /**
   * The deadline has to bound the request, not merely be consulted between
   * requests. A daemon that accepts the connection and then never answers left
   * an unsignalled `fetch` pending indefinitely, so this helper could outlive
   * the timeout it was given — in a change whose subject is bounded transfers.
   */
  it('returns within its timeout when the server accepts and then stalls', async () => {
    const held: import('node:net').Socket[] = []
    const server = createServer((request) => {
      // Accepted, and then nothing: no status line, no headers, no body.
      held.push(request.socket)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo

    try {
      const started = Date.now()
      expect(await waitForHealth(`http://127.0.0.1:${port}`, 700)).toBeNull()
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      for (const socket of held) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }, 15_000)

  it('removes a directory and says nothing went wrong', () => {
    const directory = freshDir()
    writeFileSync(join(directory, 'inside'), 'x')

    expect(removeWorkDirectory(directory)).toBeNull()
    expect(existsSync(directory)).toBe(false)
  })

  it('treats a directory that is already gone as removed', () => {
    // `force` swallows ENOENT, and every caller runs this from a `finally` that
    // may have been reached before the directory was ever created.
    expect(removeWorkDirectory(join(tmpdir(), 'looptroop-never-existed-9f2c1a'))).toBeNull()
  })

  /**
   * The contract every caller depends on: this runs from a `finally` in each of
   * them, so a throw here would replace whatever failure the script was already
   * reporting with a complaint about a temporary directory.
   *
   * Provoked with a NUL byte, which `rmSync` rejects outright. A path under a
   * file or a path that does not exist will not do it — `force` treats both as
   * already gone, which is the behaviour the two tests above pin down.
   */
  it('returns what stopped it rather than throwing', () => {
    const failure = removeWorkDirectory(join(tmpdir(), 'looptroop\u0000invalid'))

    expect(failure).toBeInstanceOf(Error)
  })
})

/**
 * `gh` and `choco` receive release credentials and mutation arguments. Naming a
 * tool and letting the operating system search `PATH` lets the first matching
 * directory decide which program that is — `shell: false` settles how the
 * arguments are read, not who reads them.
 *
 * Platform and PATH are injected, because the rules describe two platforms and
 * this runs on one.
 */
describe('trusted tool resolution', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const dir of roots.splice(0)) removeTempDir(dir)
  })

  function executableIn(directory: string, name: string) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, name), '')
    chmodSync(join(directory, name), 0o755)
    return join(directory, name)
  }

  function scratchRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-trusted-'))
    roots.push(dir)
    return dir
  }

  it('refuses a tool resolved from a directory it does not trust', () => {
    const untrusted = scratchRoot()
    const trusted = scratchRoot()
    executableIn(untrusted, 'gh')

    const resolved = resolveTrustedTool('gh', {
      env: {},
      pathValue: untrusted,
      platform: 'linux',
      trustedPrefixes: [trusted],
    })

    expect(resolved).toHaveProperty('refusal')
    expect((resolved as { refusal: string }).refusal).toContain('not in a directory this release trusts')
  })

  /**
   * The attack this exists for: something writable earlier on PATH shadowing
   * the real tool. The trusted copy must not rescue it — what would have run is
   * the first match, so that is what is judged.
   */
  it('judges the file that would actually have run, not a later trusted one', () => {
    const untrusted = scratchRoot()
    const trusted = scratchRoot()
    executableIn(untrusted, 'gh')
    executableIn(trusted, 'gh')

    const resolved = resolveTrustedTool('gh', {
      env: {},
      // The shadowing copy comes first, so it is the one that would run.
      pathValue: [untrusted, trusted].join(delimiter),
      platform: 'linux',
      trustedPrefixes: [trusted],
    })

    expect(resolved).toHaveProperty('refusal')
  })

  it('accepts a tool from a runner-owned directory', () => {
    const trusted = scratchRoot()
    const tool = executableIn(trusted, 'gh')

    expect(resolveTrustedTool('gh', {
      env: {},
      pathValue: trusted,
      platform: 'linux',
      trustedPrefixes: [trusted],
    })).toEqual({ path: tool })
  })

  /**
   * The real prefix list, against this machine — the one claim a fully injected
   * test cannot make: that the list matches how a runner is actually laid out.
   *
   * Only the tools this helper actually resolves. Naming others reads as a
   * broader claim than the guard makes: `node` lives in the hosted tool cache,
   * which was deliberately dropped from the list for being writable by the job,
   * so asserting it must be trusted contradicted the rule on purpose.
   *
   * "Not on PATH" is an acceptable answer, because which tools exist differs by
   * platform. What must never happen is a tool that *is* found sitting outside
   * every trusted prefix, which is what would silently disable a release job.
   */
  it.each(['gh', 'git', 'choco'])('resolves %s from a trusted location, or not at all', (tool) => {
    const resolved = resolveTrustedTool(tool)
    const verdict = 'path' in resolved
      ? 'trusted'
      : resolved.refusal.includes('was not found on PATH') ? 'absent' : resolved.refusal

    expect(`${tool}: ${verdict}`).toMatch(new RegExp(`^${tool}: (trusted|absent)$`))
  })

  /**
   * The bypass the first version had. `startsWith` accepts any directory whose
   * *name* begins with a trusted one, so a `gh` planted in `/usr/bin-of-mine`
   * was trusted on the strength of the string `/usr/bin` — the check defeated
   * by naming a directory carefully.
   */
  it('does not trust a directory that merely shares a prefix with a trusted one', () => {
    const root = scratchRoot()
    const trusted = join(root, 'bin')
    const lookalike = join(root, 'bin-of-mine')
    executableIn(lookalike, 'gh')

    const resolved = resolveTrustedTool('gh', {
      env: {},
      pathValue: lookalike,
      platform: 'linux',
      trustedPrefixes: [trusted],
    })

    expect(resolved).toHaveProperty('refusal')
  })

  it('trusts a subdirectory of a trusted prefix', () => {
    const trusted = scratchRoot()
    const nested = join(trusted, 'nested')
    const tool = executableIn(nested, 'gh')

    expect(resolveTrustedTool('gh', {
      env: {},
      pathValue: nested,
      platform: 'linux',
      trustedPrefixes: [trusted],
    })).toEqual({ path: tool })
  })

  /**
   * The system drive is not always C on a hosted runner, so the Windows roots
   * are read from the environment rather than written down.
   */
  it('takes the Windows roots from the environment', () => {
    const prefixes = defaultTrustedPrefixes({
      SystemRoot: 'D:\\Windows',
      ProgramFiles: 'D:\\Program Files',
      'ProgramFiles(x86)': 'D:\\Program Files (x86)',
      ProgramData: 'D:\\ProgramData',
      SystemDrive: 'D:',
    })

    expect(prefixes).toContain('D:\\Program Files')
    expect(prefixes.some((prefix) => prefix.includes('D:') && prefix.includes('chocolatey'))).toBe(true)
    expect(prefixes.some((prefix) => prefix.startsWith('C:'))).toBe(false)
  })

  /**
   * The Windows rules, exercised on whatever this is running on.
   *
   * Both helpers take the platform rather than reading `process.platform`,
   * precisely so these can run here — the lesson from the resolver regression
   * that shipped because a Windows-only rule could only fail on Windows.
   */
  describe('windows rules', () => {
    const PATHEXT = '.com;.exe;.bat;.cmd'

    it('applies PATHEXT to a bare command name', () => {
      const trusted = scratchRoot()
      const tool = executableIn(trusted, 'gh.exe')

      expect(resolveTrustedTool('gh', {
        env: {},
        pathValue: trusted,
        pathExt: PATHEXT,
        platform: 'win32',
        trustedPrefixes: [trusted],
      })).toEqual({ path: tool })
    })

    it('uses a command that names its own extension as written', () => {
      const trusted = scratchRoot()
      // `.exe` would win under PATHEXT; naming `.com` proves the extension the
      // caller wrote is the one used, rather than the one PATHEXT prefers.
      executableIn(trusted, 'gh.exe')
      const com = executableIn(trusted, 'gh.com')

      expect(resolveTrustedTool('gh.com', {
        env: {},
        pathValue: trusted,
        pathExt: PATHEXT,
        platform: 'win32',
        trustedPrefixes: [trusted],
      })).toEqual({ path: com })
    })

    /** Windows compares paths case-insensitively, so the prefix check must too. */
    it('matches a trusted prefix regardless of case', () => {
      const trusted = scratchRoot()
      const tool = executableIn(trusted, 'gh.exe')

      expect(resolveTrustedTool('gh', {
        env: {},
        pathValue: trusted,
        pathExt: PATHEXT,
        platform: 'win32',
        trustedPrefixes: [trusted.toUpperCase()],
      })).toEqual({ path: tool })
    })

    /**
     * Every caller hands the resolved path to `execFileSync` without a shell,
     * and Node cannot spawn a Windows command script that way — it fails with
     * `EINVAL`, which explains nothing. `.EXE` wins under the default PATHEXT
     * ordering, so this is a guard rather than a behaviour change, but an
     * override or an altered PATHEXT can reach it.
     */
    it('refuses a command script it cannot spawn, and says what to do', () => {
      const trusted = scratchRoot()
      executableIn(trusted, 'gh.cmd')

      const resolved = resolveTrustedTool('gh', {
        env: {},
        pathValue: trusted,
        pathExt: '.cmd',
        platform: 'win32',
        trustedPrefixes: [trusted],
      })

      expect((resolved as { refusal: string }).refusal).toContain('cannot be run without a shell')
      expect((resolved as { refusal: string }).refusal).toContain('LOOPTROOP_GH_PATH')
    })

    it('refuses a command script named by the override too', () => {
      const elsewhere = scratchRoot()
      const shim = executableIn(elsewhere, 'gh.cmd')

      expect(resolveTrustedTool('gh', { env: { LOOPTROOP_GH_PATH: shim }, pathValue: '', platform: 'win32' }))
        .toHaveProperty('refusal')
    })

    it('still refuses a sibling of a trusted prefix', () => {
      const root = scratchRoot()
      const lookalike = join(root, 'Program Files Evil')
      executableIn(lookalike, 'gh.exe')

      expect(resolveTrustedTool('gh', {
        env: {},
        pathValue: lookalike,
        pathExt: PATHEXT,
        platform: 'win32',
        trustedPrefixes: [join(root, 'Program Files')],
      })).toHaveProperty('refusal')
    })
  })

  /**
   * `??` falls back for null and undefined and *not* for the empty string, and
   * an unset-but-present variable is what a trimmed container environment
   * gives. `ProgramFiles: ''` produced the prefix `''`, which `resolve()` turns
   * into the current working directory — so the whole checkout became trusted
   * and the guard trusted anything the job could write.
   */
  it('drops an empty or relative root rather than trusting the working directory', () => {
    const prefixes = defaultTrustedPrefixes({
      ProgramFiles: '',
      'ProgramFiles(x86)': '   ',
      ProgramData: 'relative/path',
      SystemRoot: '',
    })

    expect(prefixes).not.toContain('')
    // Absolute under one convention or the other: the POSIX roots are literals
    // and the Windows ones are Windows paths whatever this is running on.
    for (const prefix of prefixes) {
      const absolute = isAbsolute(prefix) || win32.isAbsolute(prefix)
      expect(`${prefix}: ${absolute}`).toBe(`${prefix}: true`)
    }
    expect(prefixes).not.toContain('relative/path')
  })

  /**
   * The hosted tool cache looks like system infrastructure and is written by
   * every `setup-*` action, so trusting it would have widened the guard to a
   * tree the job itself can write. Neither tool this guards lives there.
   */
  it('does not trust the hosted tool cache', () => {
    const prefixes = defaultTrustedPrefixes({})

    expect(prefixes.some((prefix) => prefix.toLowerCase().includes('hostedtoolcache'))).toBe(false)
  })

  it('reports a tool that is not on PATH at all', () => {
    const resolved = resolveTrustedTool('definitely-not-installed', {
      env: {},
      pathValue: scratchRoot(),
      platform: 'linux',
    })

    expect((resolved as { refusal: string }).refusal).toContain('was not found on PATH')
  })

  /**
   * A self-hosted runner or a container image can legitimately keep `gh`
   * somewhere the prefix list does not know. An operator naming the path is a
   * different thing from a path being chosen by whatever is first on PATH.
   */
  it('takes an absolute override an operator set deliberately', () => {
    const elsewhere = scratchRoot()
    const tool = executableIn(elsewhere, 'gh')

    expect(resolveTrustedTool('gh', { env: { LOOPTROOP_GH_PATH: tool }, pathValue: '', platform: 'linux' }))
      .toEqual({ path: tool })
    // Trusted only because an operator named it: it is nowhere near a prefix.
    expect(resolveTrustedTool('gh', { env: {}, pathValue: elsewhere, platform: 'linux' }))
      .toHaveProperty('refusal')
  })

  it('refuses an override that is relative or is not an executable file', () => {
    const elsewhere = scratchRoot()
    writeFileSync(join(elsewhere, 'not-executable'), '')

    expect(resolveTrustedTool('gh', { env: { LOOPTROOP_GH_PATH: 'gh' }, pathValue: '', platform: 'linux' }))
      .toHaveProperty('refusal')
    expect(resolveTrustedTool('gh', { env: { LOOPTROOP_GH_PATH: join(elsewhere, 'nope') }, pathValue: '', platform: 'linux' }))
      .toHaveProperty('refusal')
  })
})

/**
 * The two failures a script must not treat alike.
 *
 * A tool that is *not installed* is an outcome several of these scripts are
 * measuring — `smoke-published.mjs` probes whether `yarn` is there — so falling
 * back to the name keeps the spawn's own ENOENT as the answer. A tool that *is*
 * there, in a directory this machine will not run from, is the case the whole
 * resolver exists for, and falling back would spawn exactly that file.
 */
describe('spawnProgram', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTempDir(dir)
  })

  /** Canonicalised, because the resolver realpaths its answer and macOS `/tmp` is a symlink. */
  function scratch(): string {
    const dir = makeTempDir('looptroop-spawn-program-')
    dirs.push(dir)
    return dir
  }

  function executable(directory: string, name: string): string {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, name)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
    return path
  }

  /** `PATH` is read from the real environment here, so it is restored either way. */
  function withPath<T>(pathValue: string, run: () => T): T {
    const previous = process.env.PATH
    process.env.PATH = pathValue
    try {
      return run()
    } finally {
      process.env.PATH = previous
    }
  }

  it('falls back to the name when the tool is not installed anywhere', () => {
    expect(withPath(scratch(), () => spawnProgram('definitely-not-installed-anywhere')))
      .toBe('definitely-not-installed-anywhere')
  })

  it.runIf(process.platform !== 'win32')('throws rather than spawning one found in a directory somebody else owns', () => {
    const foreign = scratch()
    const tool = executable(foreign, 'looptool')
    // Root can hand the files to another uid; anyone else stubs `getuid` so
    // that every file looks foreign, which is enough for a single-directory case.
    const asRoot = process.getuid?.() === 0
    if (asRoot) {
      chownSync(foreign, 4242, 4242)
      chownSync(tool, 4242, 4242)
    }
    const spy = asRoot ? null : vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    // The running Node's owner is trusted too — on a CI runner that is the very
    // uid being made to look foreign — so it is taken out of the case.
    const execPath = process.execPath
    if (!asRoot) process.execPath = '/nonexistent/looptroop-test/node'
    try {
      expect(() => withPath(foreign, () => spawnProgram('looptool'))).toThrow(/neither root, you, nor the owner of the Node/)
    } finally {
      spy?.mockRestore()
      process.execPath = execPath
      if (asRoot) {
        chownSync(tool, 0, 0)
        chownSync(foreign, 0, 0)
      }
    }
  })

  it.runIf(process.platform !== 'win32')('quotes a resolved path for the shell that will read it, and leaves it bare otherwise', () => {
    const spaced = join(scratch(), 'Program Files')
    const tool = executable(spaced, 'looptool')

    withPath(spaced, () => {
      // `sh` reads it here, so single quotes — inside which nothing expands.
      expect(spawnProgram('looptool', { shell: true })).toBe(`'${tool}'`)
      expect(spawnProgram('looptool')).toBe(tool)
    })
  })

  it.runIf(process.platform !== 'win32')('resolves against the environment the child gets, not this process\'s', () => {
    // A smoke that puts a freshly installed tool at the front of the child's
    // PATH resolved against the parent's, and exercised whichever older copy
    // the runner already had.
    const parent = scratch()
    const child = scratch()
    executable(parent, 'looptool')
    const wanted = executable(child, 'looptool')

    withPath(parent, () => {
      expect(spawnProgram('looptool', { env: { PATH: child } })).toBe(wanted)
    })
  })
})

describe('shell command lines', () => {
  it('quotes the program always, and not only when it holds a space', () => {
    // `C:\Tools&CI` has no space and is two commands to cmd.exe; a POSIX path
    // with `$` expands inside double quotes.
    expect(quoteProgramForShell('C:\\Tools&CI\\npm.cmd', 'win32')).toBe('"C:\\Tools&CI\\npm.cmd"')
    expect(quoteProgramForShell('/opt/$HOME/bin/tool', 'linux')).toBe("'/opt/$HOME/bin/tool'")
    expect(quoteProgramForShell("/opt/it's/tool", 'linux')).toBe("'/opt/it'\\''s/tool'")
  })

  it('quotes an argument only when leaving it bare would change it', () => {
    // Quoting every argument breaks a cmd shim comparing `%1`: cmd hands it over
    // with the quotes still on.
    expect(quoteArgForShell('--version', 'win32')).toBe('--version')
    expect(quoteArgForShell('C:\\Users\\Ada Lovelace\\x.tgz', 'win32')).toBe('"C:\\Users\\Ada Lovelace\\x.tgz"')
    expect(quoteArgForShell('a&b', 'win32')).toBe('"a&b"')
    expect(quoteArgForShell('say "hi"', 'win32')).toBe('"say ""hi"""')
    expect(quoteArgForShell('--prefix=/tmp/x', 'linux')).toBe('--prefix=/tmp/x')
    expect(quoteArgForShell('a b;rm -rf', 'linux')).toBe("'a b;rm -rf'")
  })

  it('builds one line, so Node never joins an argument array unquoted', () => {
    expect(shellCommandLine('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', 'C:\\a b\\x.tgz'], 'win32'))
      .toBe('"C:\\Program Files\\nodejs\\npm.cmd" install -g "C:\\a b\\x.tgz"')
  })

  it.runIf(process.platform !== 'win32')('survives a real shell with spaces and metacharacters in the arguments', () => {
    // The claim that matters, checked against /bin/sh rather than against a
    // string: three arguments go in, three come out, and nothing runs.
    const line = shellCommandLine(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'c&d', '$(touch x)'])
    const output = execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(['a b', 'c&d', '$(touch x)'])
  })
})

describe('spawnProgram when a tool is not installed', () => {
  it('refuses to fall back to the name when PATH would reach the current directory', () => {
    // `PATH=/usr/bin:` ends in an empty entry, which the OS reads as the
    // working directory. Handing back the bare name there ran `./tool`.
    expect(() => spawnProgram('definitely-not-installed-anywhere', { env: { PATH: '/nonexistent-looptroop-bin:' } }))
      .toThrow(/relative or empty entry/)
    expect(spawnProgram('definitely-not-installed-anywhere', { env: { PATH: '/nonexistent-looptroop-bin' } }))
      .toBe('definitely-not-installed-anywhere')
  })

  it('never hands back a relative path to run from the current directory', () => {
    expect(() => spawnProgram('./evil', { env: { PATH: '' } })).toThrow(/relative path/)
  })

  it('keeps an empty argument on a Windows command line', () => {
    expect(shellCommandLine('C:\\x\\tool.cmd', ['a', '', 'b'], 'win32')).toBe('"C:\\x\\tool.cmd" a "" b')
  })
})

