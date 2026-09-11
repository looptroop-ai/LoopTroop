import { spawnSync } from 'node:child_process'
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import {
  bareNameSearchReachesWorkingDirectory,
  findTrustedExecutablePath,
  launchThroughInterpreter,
  needsCommandInterpreter,
  planProgramLaunch,
  requireTrustedExecutablePath,
  resolveCommandInterpreter,
  resolveTrustedExecutable,
  resolveTrustedProgram,
  trustedSearchDirectories,
  TRUSTED_EXECUTABLE_DIRS_ENV,
  type CachedResolution,
} from '../executablePath'

/**
 * Every case here injects `env`, `platform` and `cache`.
 *
 * The module's whole job is to answer for the machine it is running on, so a
 * test that let it read the real `PATH` would be asserting this checkout's
 * layout. The cache is injected for the same reason: a process-wide `Map` makes
 * the second test in a file depend on the first.
 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
})

/**
 * A temp directory whose ancestors belong to root.
 *
 * Every directory above a tool is judged, and the unprivileged branch of
 * `ownedBySomeoneElse` makes everything this user owns look foreign. macOS puts
 * `tmpdir()` in `/var/folders/…/T`, which the user owns, so a case meant to be
 * refused at one directory was refused at an ancestor instead — and a drive-mount
 * case meant to pass was refused above the mount. `/tmp` is root's on both, and
 * its real path is taken so the path as written and the real one agree.
 */
function makeRootOwnedTempDir(prefix: string): string {
  return process.platform === 'win32' ? makeTempDir(prefix) : mkdtempSync(join(realpathSync('/tmp'), prefix))
}

function tempRoot(): string {
  const root = makeRootOwnedTempDir('executable-path-')
  roots.push(root)
  return root
}

/** A file the platform will agree is a program. */
function makeExecutable(directory: string, name: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

function freshCache(): Map<string, CachedResolution> {
  return new Map<string, CachedResolution>()
}

/**
 * Makes `paths` belong to somebody other than root or the test runner.
 *
 * As root the files really are handed to another uid. As anyone else they
 * cannot be, so `process.getuid` is stubbed instead — which makes *every* file
 * look foreign, so a case that needs one foreign path among trusted ones is
 * root-only (`itAsRoot`). Returns the undo.
 */
const FOREIGN_UID = 4242
function ownedBySomeoneElse(...paths: string[]): () => void {
  if (process.getuid?.() === 0) {
    for (const path of paths) chownSync(path, FOREIGN_UID, FOREIGN_UID)
    return () => {
      for (const path of paths) chownSync(path, 0, 0)
    }
  }
  // The owner of the running Node is trusted too, and on a CI runner that is the
  // runner user — the very uid being made to look foreign. Pointing execPath at
  // nothing takes that rule out of the case, or it would pass for the wrong
  // reason on exactly the machines that matter.
  const uid = process.getuid?.() ?? 0
  const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
  const execPath = process.execPath
  process.execPath = '/nonexistent/looptroop-test/node'
  return () => {
    spy.mockRestore()
    process.execPath = execPath
  }
}

const posix = process.platform !== 'win32'
/** The mode bits are the check; NTFS reports 0777 for everything and cannot express these. */
const itPosix = posix ? it : it.skip
/** Cases that need one foreign path among trusted ones, which only root can arrange. */
const itAsRoot = posix && process.getuid?.() === 0 ? it : it.skip
/** Cases that need a path this user cannot `stat`, which root never has. */
const itAsNonRoot = posix && process.getuid?.() !== 0 ? it : it.skip

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

describe('trustedSearchDirectories', () => {
  it('prepends the override, and does not use it to filter PATH', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['/usr/bin', '/usr/local/bin'].join(':') },
      policyEnv: { [TRUSTED_EXECUTABLE_DIRS_ENV]: '/opt/tools' },
      // POSIX rules, named: on a Windows host the default platform would seed
      // the real system directories and split on `;`.
      platform: 'linux',
    })

    // Prepended: an operator naming a directory is answering "the tool is not
    // on PATH", which filtering PATH by the same value cannot serve.
    expect(directories).toEqual(['/opt/tools', '/usr/bin', '/usr/local/bin'])
  })

  it('drops the empty segment, the current directory and relative entries', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['', '.', '..', 'relative/bin', '/usr/bin'].join(':') },
      // POSIX rules, named: on a Windows host the default platform would seed
      // the real system directories and split on `;`.
      platform: 'linux',
    })

    expect(directories).toEqual(['/usr/bin'])
  })

  it('keeps the first occurrence of a directory named twice', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['/usr/bin', '/usr/local/bin', '/usr/bin/'].join(':') },
      // POSIX rules, named: on a Windows host the default platform would seed
      // the real system directories and split on `;`.
      platform: 'linux',
    })

    expect(directories).toEqual(['/usr/bin', '/usr/local/bin'])
  })
})

describe('the trust-policy matrix', () => {
  itPosix('resolves a bare name from a directory on PATH', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')

    expect(resolveTrustedExecutable('looptool', {
      env: { PATH: join(root, 'bin') },
      platform: 'linux',
      cache: freshCache(),
    })).toEqual({ path: tool, target: tool })
  })

  itPosix('resolves a project-local tool that is nowhere near a system directory', () => {
    // `node_modules/.bin` on PATH is how a repo's own linter is found, and a
    // resolver that insisted on /usr/bin would refuse every one of them.
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'project', 'node_modules', '.bin'), 'eslint')

    expect(findTrustedExecutablePath('eslint', {
      env: { PATH: join(root, 'project', 'node_modules', '.bin') },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(tool)
  })

  it('refuses a name carrying a path separator rather than resolving it', () => {
    for (const name of ['./looptool', 'bin/looptool', 'bin\\looptool']) {
      expect(resolveTrustedExecutable(name, { env: { PATH: '' }, platform: 'linux', cache: null }).reason)
        .toContain('is a path, not a program name')
    }
  })

  it('refuses an absolute path rather than resolving it', () => {
    expect(resolveTrustedExecutable('/usr/bin/git', { env: { PATH: '' }, platform: 'linux', cache: null }).reason)
      .toContain('is a path, not a program name')
  })

  itPosix('accepts a world-writable directory, because the mode is not the rule', () => {
    // GitHub's Ubuntu runners ship a world-writable /usr/local/bin, and the first
    // version of this refused the npm there — LoopTroop's own daemon, inside a
    // container, calling npm missing. Ownership is the rule; the mode bits are
    // not consulted.
    const root = tempRoot()
    const open = join(root, 'open')
    const tool = makeExecutable(open, 'looptool')
    chmodSync(open, 0o777)

    expect(findTrustedExecutablePath('looptool', {
      env: { PATH: open },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(tool)
  })

  itPosix('refuses a hit in a directory somebody else owns instead of walking past it', () => {
    // Walking on would resolve to a *different* program than the operating
    // system would have run, which is a worse answer than refusing.
    const root = tempRoot()
    const foreign = join(root, 'foreign')
    const later = join(root, 'later')
    makeExecutable(foreign, 'looptool')
    makeExecutable(later, 'looptool')
    const restore = ownedBySomeoneElse(foreign, join(foreign, 'looptool'))
    try {
      const resolution = resolveTrustedExecutable('looptool', {
        env: { PATH: [foreign, later].join(delimiter) },
        platform: 'linux',
        cache: freshCache(),
      })

      expect(resolution.path).toBeUndefined()
      expect(resolution.reason).toContain('which is neither root, you, nor the owner of the Node')
      expect(resolution.reason).toContain(TRUSTED_EXECUTABLE_DIRS_ENV)
      expect(resolution.refusedAt).toBe(join(foreign, 'looptool'))
    } finally {
      restore()
    }
  })

  itAsRoot('refuses a link in a trusted directory that points into somebody else\'s tree', () => {
    // Judging only the search directory was the gap: the link was trusted, the
    // file it led to was not, and the resolver returned the file.
    const root = tempRoot()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    const target = makeExecutable(elsewhere, 'looptool')
    symlinkSync(target, join(bin, 'looptool'))
    const restore = ownedBySomeoneElse(elsewhere, target)
    try {
      const resolution = resolveTrustedExecutable('looptool', { env: { PATH: bin }, platform: 'linux', cache: freshCache() })

      expect(resolution.path).toBeUndefined()
      expect(resolution.reason).toContain('target directory is owned by uid')
    } finally {
      restore()
    }
  })

  itAsRoot('refuses a file somebody else owns in a directory that is otherwise fine', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const restore = ownedBySomeoneElse(tool)
    try {
      expect(resolveTrustedExecutable('looptool', { env: { PATH: join(root, 'bin') }, platform: 'linux', cache: freshCache() }).reason)
        .toContain('file is owned by uid')
    } finally {
      restore()
    }
  })

  itPosix('resolves through the override even when the directory is on no PATH', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'opt'), 'looptool')

    expect(findTrustedExecutablePath('looptool', {
      env: { PATH: '/nonexistent' },
      policyEnv: { [TRUSTED_EXECUTABLE_DIRS_ENV]: join(root, 'opt') },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(tool)
  })

  itPosix('lets the override vouch for a directory a service account owns', () => {
    // The override is how an operator says "this directory belongs to someone
    // else and that is deliberate" — a shared toolchain under /opt, say.
    const root = tempRoot()
    const shared = join(root, 'shared')
    const tool = makeExecutable(shared, 'looptool')
    const restore = ownedBySomeoneElse(shared, tool)
    try {
      expect(findTrustedExecutablePath('looptool', {
        env: { PATH: '' },
        policyEnv: { [TRUSTED_EXECUTABLE_DIRS_ENV]: shared },
        platform: 'linux',
        cache: freshCache(),
      })).toBe(tool)
    } finally {
      restore()
    }
  })

  itPosix('degrades an unreadable PATH entry instead of throwing', () => {
    // `throwIfNoEntry: false` suppresses ENOENT and ENOTDIR, and nothing else.
    // A symlink loop on PATH makes every candidate under it ELOOP — the same
    // shape as EACCES on a directory this user cannot read, which only a
    // non-root runner can arrange — and that threw out of a function whose
    // contract is to return an answer. (A plain file on PATH does not
    // reproduce it: ENOTDIR is one of the two codes Node swallows.)
    const root = tempRoot()
    symlinkSync(join(root, 'loop'), join(root, 'loop'))
    const tool = makeExecutable(join(root, 'bin'), 'looptool')

    expect(findTrustedExecutablePath('looptool', {
      env: { PATH: [join(root, 'loop'), join(root, 'bin')].join(delimiter) },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(tool)
  })

  itPosix('does not resolve from the current directory when PATH carries an empty segment', () => {
    // Both `''` and `.` mean the current directory to a shell, and the daemon's
    // current directory is a checkout — the one place a program named `git`
    // must never be picked up from. `process.cwd` is stubbed rather than
    // changed for real: vitest runs these in a worker, where `chdir` throws.
    const root = tempRoot()
    makeExecutable(root, 'looptool')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    try {
      expect(findTrustedExecutablePath('looptool', {
        env: { PATH: ['', '.'].join(delimiter) },
        platform: 'linux',
        cache: freshCache(),
      })).toBeNull()
    } finally {
      cwd.mockRestore()
    }
  })

  it('reports a missing tool as missing, not as untrusted', () => {
    const resolution = resolveTrustedExecutable('definitely-not-installed', {
      env: { PATH: tempRoot() },
      platform: 'linux',
      cache: freshCache(),
    })

    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain('was not found in any trusted directory')
  })

  it('refuses an empty name', () => {
    expect(resolveTrustedExecutable('', { env: {}, platform: 'linux', cache: null }).reason)
      .toContain('empty program name')
  })
})

describe('symlink indirection', () => {
  itPosix('spawns the link it found, and judges the store it points at', () => {
    // Homebrew and Nix both put a link in a trusted directory pointing into a
    // store no trust list would ever name — so the store is judged by ownership,
    // not by location. What is *spawned* is the link: Homebrew takes its prefix
    // from `$0`, and `brew` started by its real path decided it lived in
    // `.linuxbrew/Homebrew`, found no bottles and compiled Node for forty
    // minutes. Rustup, mise and Volta shims dispatch on the name the same way.
    const root = tempRoot()
    const store = join(root, 'nix', 'store', 'abcdef-git-2.51.0', 'bin')
    const target = makeExecutable(store, 'git')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(target, join(bin, 'git'))

    expect(resolveTrustedExecutable('git', {
      env: { PATH: bin },
      platform: 'linux',
      cache: freshCache(),
    })).toEqual({ path: join(bin, 'git'), target })
  })

  itPosix('resolves a shim to the shim, because the shim is the program', () => {
    // Volta and Corepack install a real executable that re-execs the tool. It is
    // the file PATH names and the file that must run.
    const root = tempRoot()
    const shim = makeExecutable(join(root, 'volta', 'bin'), 'node', '#!/bin/sh\nexec volta-real "$@"\n')

    expect(findTrustedExecutablePath('node', {
      env: { PATH: join(root, 'volta', 'bin') },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(shim)
  })
})

describe('Windows resolution', () => {
  /**
   * `SystemRoot` names nothing: the system directories are searched ahead of
   * PATH, and on a real Windows runner they exist — so without this the host's
   * own `powershell.exe` answered before the test's.
   */
  const NO_WINDOWS = '/nonexistent-windows-root'
  /** The child's PATH, and the policy — system root and PATHEXT — beside it, where it is read. */
  function windowsOptions(root: string, policy: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; policyEnv: NodeJS.ProcessEnv } {
    return { env: { PATH: join(root, 'bin'), USERPROFILE: root }, policyEnv: { SystemRoot: NO_WINDOWS, ...policy } }
  }

  it('applies PATHEXT to a bare name', () => {
    const root = tempRoot()
    // `.EXE` before `.CMD` in PATHEXT, and the .CMD exists too: the order in the
    // variable is what decides, exactly as CreateProcess would not.
    makeExecutable(join(root, 'bin'), 'tool.CMD')
    const exe = makeExecutable(join(root, 'bin'), 'tool.EXE')

    expect(findTrustedExecutablePath('tool', {
      ...windowsOptions(root, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('returns an npm-style .cmd shim rather than pretending npm is missing', () => {
    // npm ships as npm.cmd. Callers decide how to launch a command script; a
    // resolver that refused it here is why `doctor` once called npm missing on
    // a machine where npm works.
    const root = tempRoot()
    const shim = makeExecutable(join(root, 'bin'), 'npm.CMD')

    expect(findTrustedExecutablePath('npm', {
      ...windowsOptions(root, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
      platform: 'win32',
      cache: freshCache(),
    })).toBe(shim)
  })

  it('honours an extension already present in the name', () => {
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'bin'), 'powershell.EXE')

    expect(findTrustedExecutablePath('powershell.EXE', {
      ...windowsOptions(root, { PATHEXT: '.COM;.EXE' }),
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('accepts a toolchain wherever it was installed, because Windows has no ownership to check', () => {
    // Every hosted Windows runner keeps npm in C:\hostedtoolcache, which no
    // location list predicted, and NTFS reports uid 0 and mode 0777 for every
    // file, so there is no ownership rule to apply instead.
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'hostedtoolcache', 'node', 'x64'), 'npm.CMD')

    expect(findTrustedExecutablePath('npm', {
      env: { PATH: join(root, 'hostedtoolcache', 'node', 'x64') },
      policyEnv: { PATHEXT: '.EXE;.CMD', SystemRoot: NO_WINDOWS },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('parses a real Windows PATH by Windows rules, and searches the system directories first', () => {
    // The platform seam used to cover PATHEXT and not the parsing: PATH was
    // split on the host's `:` and `C:\...` judged by POSIX rules, so these
    // Windows semantics were never exercised off Windows. And CreateProcess
    // looks in the system directories before PATH, which is why `taskkill`
    // works from a shell whose PATH never mentions it.
    expect(trustedSearchDirectories({
      env: {
        PATH: ['C:\\Tools\\', '"C:\\Program Files\\nodejs"', '', '.', 'relative\\bin', 'c:\\windows\\system32'].join(win32.delimiter),
      },
      policyEnv: { SystemRoot: 'C:\\Windows' },
      platform: 'win32',
    })).toEqual([
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Tools',
      'C:\\Program Files\\nodejs',
    ])
  })

  it('seeds no system directories on any other platform', () => {
    expect(trustedSearchDirectories({ env: { PATH: '/usr/bin' }, policyEnv: { SystemRoot: 'C:\\Windows' }, platform: 'linux' }))
      .toEqual(['/usr/bin'])
  })

  it('strips the quotes Windows tolerates around a PATH entry', () => {
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'bin'), 'tool.EXE')

    expect(findTrustedExecutablePath('tool', {
      env: { PATH: `"${join(root, 'bin')}"`, USERPROFILE: root },
      policyEnv: { PATHEXT: '.EXE', SystemRoot: NO_WINDOWS },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('reads PATHEXT from the policy environment, not from the child\'s', () => {
    // Which extensions make a file a program decides which file runs. A child
    // environment putting `.CMD` ahead of `.EXE` chose the script.
    const root = tempRoot()
    makeExecutable(join(root, 'bin'), 'tool.CMD')
    const exe = makeExecutable(join(root, 'bin'), 'tool.EXE')

    expect(findTrustedExecutablePath('tool', {
      env: { PATH: join(root, 'bin'), PATHEXT: '.CMD;.EXE' },
      policyEnv: { PATHEXT: '.EXE;.CMD', SystemRoot: NO_WINDOWS },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  itAsNonRoot('resolves a Windows App Execution Alias as the program at its own path', () => {
    // `fs.stat` refuses an alias with EACCES, `fs.realpath` too, and `lstat`
    // sees it. A link into a directory this user cannot search has the same
    // signature here, which is how the Windows rule is exercised off Windows —
    // and why root, which can search anything, skips it.
    const root = tempRoot()
    const packageDirectory = join(root, 'WindowsApps-package')
    makeExecutable(packageDirectory, 'winget.EXE')
    const aliases = join(root, 'WindowsApps')
    mkdirSync(aliases)
    const alias = join(aliases, 'winget.EXE')
    symlinkSync(join(packageDirectory, 'winget.EXE'), alias)
    chmodSync(packageDirectory, 0o000)
    try {
      const options = { env: { PATH: aliases }, policyEnv: { PATHEXT: '.EXE', SystemRoot: NO_WINDOWS }, platform: 'win32' as const }
      const cache = freshCache()
      expect(resolveTrustedExecutable('winget', { ...options, cache })).toEqual({ path: alias, target: alias })
      // Served from the cache, which re-checks it the same way.
      const entry = [...cache.values()][0]
      expect(resolveTrustedExecutable('winget', { ...options, cache })).toEqual({ path: alias, target: alias })
      expect([...cache.values()][0]).toBe(entry)
      expect(resolveTrustedProgram(alias, { platform: 'win32', policyEnv: {} })).toEqual({ path: alias, target: alias })
      // POSIX has no such thing: the same link is simply not a program there,
      // not a program that is refused.
      const posixAnswer = resolveTrustedExecutable('winget.EXE', { env: { PATH: aliases }, policyEnv: {}, platform: 'linux', cache: null })
      expect(posixAnswer.reason).toContain('was not found in any trusted directory')
      expect(posixAnswer.refusedAt).toBeUndefined()
    } finally {
      chmodSync(packageDirectory, 0o755)
    }
  })

  itPosix('does not take a dangling link, or a path stat fails on another way, for an alias', () => {
    // Only EACCES is the alias signature. A link whose target is gone fails
    // with ENOENT, and a link loop with ELOOP; neither is a program.
    const root = tempRoot()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    symlinkSync(join(root, 'gone.EXE'), join(bin, 'tool.EXE'))
    symlinkSync(join(bin, 'loop.EXE'), join(bin, 'loop.EXE'))
    const options = { env: { PATH: bin }, policyEnv: { PATHEXT: '.EXE', SystemRoot: NO_WINDOWS }, platform: 'win32' as const, cache: null }

    expect(findTrustedExecutablePath('tool', options)).toBeNull()
    expect(findTrustedExecutablePath('loop', options)).toBeNull()
  })

  const runnerAlias = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')
    : null
  const itWithRunnerAlias = runnerAlias !== null && lstatOrNull(runnerAlias) !== null ? it : it.skip
  itWithRunnerAlias('resolves the real winget alias on a Windows machine that has one', () => {
    // The case the WinGet lane failed on: `winget` on PATH only as an alias.
    expect(findTrustedExecutablePath('winget', { cache: null })).toMatch(/\\WindowsApps\\winget\.exe$/i)
  })

  it('judges a Windows path by Windows rules when the program is named outright', () => {
    // `C:\\...` is not absolute to the host's `path` off Windows, so it was sent
    // to the name resolver and refused as "a path, not a program name".
    expect(resolveTrustedProgram('C:\\nonexistent\\tool.exe', { platform: 'win32', policyEnv: { SystemRoot: NO_WINDOWS } }).reason)
      .toBe('C:\\nonexistent\\tool.exe is not an executable file.')
  })
})

describe('the WSL drive-mount exception', () => {
  itPosix('accepts a directory on a Windows drive mount whatever uid it reports', () => {
    // DrvFs shows every file as owned by the uid the mount was made with —
    // root for an elevated mount, anything for a custom `uid=`. That owner
    // describes a mount option, not a person.
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'git.exe')
    const restore = ownedBySomeoneElse(bin, tool)
    try {
      expect(findTrustedExecutablePath('git.exe', {
        env: { PATH: bin },
        platform: 'linux',
        readMountTable: () => `/dev/sda1 / ext4 rw 0 0\nC:\\ ${root} drvfs rw 0 0\n`,
        cache: freshCache(),
      })).toBe(tool)
    } finally {
      restore()
    }
  })

  itPosix('does not extend the exception to a real filesystem below the mount', () => {
    // The longest matching mount point wins, as the kernel resolves it. A path
    // that merely *looks* like it is under /mnt is not the test.
    const root = tempRoot()
    const bin = join(root, 'inner', 'bin')
    const tool = makeExecutable(bin, 'git')
    const restore = ownedBySomeoneElse(bin, tool)
    try {
      expect(resolveTrustedExecutable('git', {
        env: { PATH: bin },
        platform: 'linux',
        readMountTable: () => `C:\\ ${root} drvfs rw 0 0\n/dev/sdb1 ${join(root, 'inner')} ext4 rw 0 0\n`,
        cache: freshCache(),
      }).reason).toContain('which is neither root, you, nor the owner of the Node')
    } finally {
      restore()
    }
  })

  itPosix('treats an unreadable mount table as "not WSL"', () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'git')
    const restore = ownedBySomeoneElse(bin, tool)
    try {
      expect(resolveTrustedExecutable('git', {
        env: { PATH: bin },
        platform: 'linux',
        readMountTable: () => '',
        cache: freshCache(),
      }).reason).toContain('which is neither root, you, nor the owner of the Node')
    } finally {
      restore()
    }
  })

  itPosix('decodes the octal escapes /proc/mounts uses for a space', () => {
    // The mount point sits directly under the temp root, not below a directory
    // this test made: every directory above a tool is judged now, and the test's
    // own directories look foreign to the unprivileged branch of the helper.
    const mountPoint = makeRootOwnedTempDir('executable path ')
    roots.push(mountPoint)
    const tool = makeExecutable(mountPoint, 'git.exe')
    const restore = ownedBySomeoneElse(mountPoint, tool)
    try {
      expect(findTrustedExecutablePath('git.exe', {
        env: { PATH: mountPoint },
        platform: 'linux',
        readMountTable: () => `C:\\ ${mountPoint.replace(/ /g, '\\040')} drvfs rw 0 0\n`,
        cache: freshCache(),
      })).toBe(tool)
    } finally {
      restore()
    }
  })

})

describe('the resolution cache', () => {
  itPosix('answers the second call from the cache', () => {
    // Same PATH both times, so a fresh walk would also return the tool — the
    // first version of this test proved nothing for exactly that reason. What
    // tells a hit from a walk is the entry: a walk writes a new one.
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: join(root, 'bin') }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    const entry = [...cache.values()][0]
    expect(entry).toBeDefined()

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    expect([...cache.values()][0]).toBe(entry)
  })

  itPosix('re-resolves when the binary was replaced in place', () => {
    // `brew upgrade git` writes a new file at the same path. A cache that
    // trusted the path alone would keep spawning a program that is no longer
    // the one at that name.
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'looptool', '#!/bin/sh\nexit 0\n')
    // Pinned to a whole millisecond and then pinned back after the rewrite, so
    // the *only* field that changes is the size. Without this the timestamp
    // moves and the case proves the mtime check rather than the size one —
    // which is what it did until the size check was mutated away and every test
    // still passed.
    const pinned = new Date(1_700_000_000_000)
    utimesSync(tool, pinned, pinned)
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    findTrustedExecutablePath('looptool', options)
    const before = [...cache.values()][0]
    expect(before).toBeDefined()

    makeExecutable(bin, 'looptool', '#!/bin/sh\nexit 1\n# replaced\n')
    utimesSync(tool, pinned, pinned)
    expect(statSync(tool).mtimeMs).toBe(before!.mtimeMs)
    expect(statSync(tool).ino).toBe(before!.ino)

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    expect([...cache.values()][0]?.size).not.toBe(before!.size)
  })

  itPosix('re-resolves when a link is retargeted and the old version is kept', () => {
    // Homebrew kegs and the Nix store both keep the previous version on disk.
    // The first test of this deleted the old target, which forced a miss and hid
    // that a cache watching only the target kept serving version 1.0 forever.
    const root = tempRoot()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const oldTarget = makeExecutable(join(root, 'store', '1.0'), 'git')
    symlinkSync(oldTarget, join(bin, 'git'))
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    expect(resolveTrustedExecutable('git', options).target).toBe(oldTarget)

    const newTarget = makeExecutable(join(root, 'store', '2.0'), 'git')
    symlinkSync(newTarget, join(bin, 'git.new'))
    renameSync(join(bin, 'git.new'), join(bin, 'git'))

    expect(resolveTrustedExecutable('git', options).target).toBe(newTarget)
    expect(statSync(oldTarget).isFile()).toBe(true)
  })

  itPosix('notices a candidate that appeared earlier on PATH after the first lookup', () => {
    // A newer git installed into ~/.local/bin, ahead of /usr/bin, is what the
    // operating system would now run. A cache that only re-checked its own entry
    // kept serving the old one until the daemon restarted.
    const root = tempRoot()
    const early = join(root, 'early')
    mkdirSync(early, { recursive: true })
    const late = makeExecutable(join(root, 'late'), 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: [early, join(root, 'late')].join(delimiter) }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('looptool', options)).toBe(late)
    const earlier = makeExecutable(early, 'looptool')

    expect(findTrustedExecutablePath('looptool', options)).toBe(earlier)
  })

  itPosix('drops a cached tool that is no longer executable', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: join(root, 'bin') }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    chmodSync(tool, 0o644)

    // Root can execute anything with an execute bit and nothing without one, so
    // this holds whoever runs the suite.
    expect(findTrustedExecutablePath('looptool', options)).toBeNull()
  })

  itPosix('re-checks trust on a hit, not only on the first lookup', () => {
    // A directory that changes owner after the first lookup kept serving the
    // cached answer to a daemon that runs for days.
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    const restore = ownedBySomeoneElse(bin, tool)
    try {
      expect(resolveTrustedExecutable('looptool', options).reason).toContain('which is neither root, you, nor the owner of the Node')
    } finally {
      restore()
    }
  })

  itPosix('reports a tool that disappeared rather than serving the cached path', () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    makeExecutable(bin, 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    findTrustedExecutablePath('looptool', options)
    unlinkSync(join(bin, 'looptool'))

    expect(findTrustedExecutablePath('looptool', options)).toBeNull()
  })

  itPosix('does not serve one platform\'s answer to another', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const cache = freshCache()

    expect(findTrustedExecutablePath('looptool', { env: { PATH: join(root, 'bin') }, platform: 'linux', cache })).toBe(tool)
    // Windows would look for looptool.EXE and find nothing, and the trust rule
    // is a different one; a shared key would hand it the POSIX answer.
    expect(findTrustedExecutablePath('looptool', {
      env: { PATH: join(root, 'bin'), USERPROFILE: root },
      policyEnv: { PATHEXT: '.EXE', SystemRoot: '/nonexistent-windows-root' },
      platform: 'win32',
      cache,
    })).toBeNull()
  })
})

describe('requireTrustedExecutablePath', () => {
  it('throws with the reason, so the caller can print it', () => {
    expect(() => requireTrustedExecutablePath('definitely-not-installed', {
      env: { PATH: tempRoot() },
      platform: 'linux',
      cache: freshCache(),
    })).toThrow(/was not found in any trusted directory/)
  })

  itPosix('returns the path when there is one', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')

    expect(requireTrustedExecutablePath('looptool', {
      env: { PATH: join(root, 'bin') },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(tool)
  })
})

describe('resolveTrustedProgram', () => {
  itPosix('holds a program named by absolute path to the same ownership rule', () => {
    // No search to hijack, but a file in somebody else's directory is no more
    // trustworthy for having been named outright. `refusedAt` is what stops a
    // caller that falls back on "not found" from falling back onto it.
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const restore = ownedBySomeoneElse(join(root, 'bin'), tool)
    try {
      const resolution = resolveTrustedProgram(tool, { platform: 'linux' })
      expect(resolution.path).toBeUndefined()
      expect(resolution.refusedAt).toBe(tool)
    } finally {
      restore()
    }
  })

  itPosix('returns the real file for a program named by absolute path', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')

    expect(resolveTrustedProgram(tool, { platform: 'linux' })).toEqual({ path: tool, target: tool })
  })
})

describe('round-2 trust rules', () => {
  itPosix('trusts whoever owns the Node running LoopTroop', () => {
    // Under `sudo "$(which node)"` this process is root and the toolchain
    // belongs to the invoking user; root refusing it refused the Node it was
    // itself running from. Whoever owns the interpreter already controls every
    // line this process runs, so trusting that owner widens nothing.
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const fakeNode = makeExecutable(join(root, 'node-home'), 'node')
    const execPath = process.execPath
    const asRoot = process.getuid?.() === 0
    // Root hands the tool and the fake Node to one other user; anyone else
    // makes their own files look foreign and leaves the fake Node theirs.
    if (asRoot) for (const path of [root, join(root, 'bin'), tool, join(root, 'node-home'), fakeNode]) chownSync(path, FOREIGN_UID, FOREIGN_UID)
    const spy = asRoot ? null : vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    try {
      process.execPath = fakeNode
      expect(findTrustedExecutablePath('looptool', { env: { PATH: join(root, 'bin') }, platform: 'linux', cache: freshCache() })).toBe(tool)

      // And only that owner: with the interpreter somewhere else, the same
      // tool is refused.
      process.execPath = '/nonexistent/looptroop-test/node'
      expect(resolveTrustedExecutable('looptool', { env: { PATH: join(root, 'bin') }, platform: 'linux', cache: freshCache() }).reason)
        .toContain('neither root, you, nor the owner of the Node')
    } finally {
      process.execPath = execPath
      spy?.mockRestore()
      if (asRoot) for (const path of [root, join(root, 'bin'), tool, join(root, 'node-home'), fakeNode]) chownSync(path, 0, 0)
    }
  })

  itAsRoot('refuses a tool whose parent directory somebody else owns', () => {
    // Ownership is the only control now mode bits are not read, and whoever
    // owns a directory's parent can rename it out from under the tool.
    const root = tempRoot()
    const parent = join(root, 'parent')
    const tool = makeExecutable(join(parent, 'bin'), 'looptool')
    const restore = ownedBySomeoneElse(parent)
    try {
      const resolution = resolveTrustedExecutable('looptool', { env: { PATH: join(parent, 'bin') }, platform: 'linux', cache: freshCache() })
      expect(resolution.path).toBeUndefined()
      expect(resolution.reason).toContain(`${parent}, above its directory,`)
      expect(tool).toBeDefined()
    } finally {
      restore()
    }
  })

  itPosix('accepts a WSL 9p drive mount only when the mount says it is a Windows drive', () => {
    // `9p` and `virtiofs` are also QEMU shares and Docker Desktop volumes. Only
    // a Windows-drive source or WSL's `aname=drvfs` option earns the exemption.
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'git.exe')
    const restore = ownedBySomeoneElse(bin, tool)
    try {
      const lookup = (table: string) => resolveTrustedExecutable('git.exe', {
        env: { PATH: bin },
        platform: 'linux',
        readMountTable: () => table,
        cache: freshCache(),
      })

      expect(lookup(`drvfs ${root} 9p rw,aname=drvfs;path=C:\\;uid=1000 0 0\n`).path).toBe(tool)
      expect(lookup(`C:\\134 ${root} virtiofs rw 0 0\n`).path).toBe(tool)
      expect(lookup(`share ${root} 9p rw,trans=virtio 0 0\n`).reason).toContain('neither root, you')
      expect(lookup(`myfs / virtiofs rw 0 0\n`).reason).toContain('neither root, you')
    } finally {
      restore()
    }
  })

  itPosix('reads the override from the policy environment, not from the child\'s', () => {
    // A command that could set its own LOOPTROOP_TRUSTED_EXECUTABLE_DIRS could
    // vouch for any directory it liked.
    const root = tempRoot()
    const shared = join(root, 'shared')
    const tool = makeExecutable(shared, 'looptool')
    const restore = ownedBySomeoneElse(shared, tool)
    try {
      const childSaysSo = resolveTrustedExecutable('looptool', {
        env: { PATH: shared, [TRUSTED_EXECUTABLE_DIRS_ENV]: shared },
        policyEnv: { PATH: '' },
        platform: 'linux',
        cache: freshCache(),
      })
      expect(childSaysSo.path).toBeUndefined()

      expect(findTrustedExecutablePath('looptool', {
        env: { PATH: shared },
        policyEnv: { [TRUSTED_EXECUTABLE_DIRS_ENV]: shared },
        platform: 'linux',
        cache: freshCache(),
      })).toBe(tool)
    } finally {
      restore()
    }
  })

  itPosix('lets the override vouch for a program named by absolute path, too', () => {
    const root = tempRoot()
    const shared = join(root, 'shared')
    const tool = makeExecutable(shared, 'looptool')
    const restore = ownedBySomeoneElse(shared, tool)
    try {
      expect(resolveTrustedProgram(tool, { platform: 'linux' }).refusedAt).toBe(tool)
      expect(resolveTrustedProgram(tool, { platform: 'linux', policyEnv: { [TRUSTED_EXECUTABLE_DIRS_ENV]: shared } }).path).toBe(tool)
    } finally {
      restore()
    }
  })

})

describe('round-3 trust rules', () => {
  itPosix('reads the policy from this process, not from the environment being searched, by default', () => {
    // The default used to be the child's environment, so every caller resolving
    // for a child had to remember to split the two — and three did not.
    const root = tempRoot()
    const shared = join(root, 'shared')
    makeExecutable(shared, 'looptool')
    const restore = ownedBySomeoneElse(shared, join(shared, 'looptool'))
    try {
      const resolution = resolveTrustedExecutable('looptool', {
        env: { PATH: shared, [TRUSTED_EXECUTABLE_DIRS_ENV]: shared },
        platform: 'linux',
        cache: freshCache(),
      })
      expect(resolution.refusedAt).toBe(join(shared, 'looptool'))
      // And for a program named outright, which read it the same way.
      expect(resolveTrustedProgram(join(shared, 'looptool'), { env: { [TRUSTED_EXECUTABLE_DIRS_ENV]: shared }, platform: 'linux' }).refusedAt)
        .toBe(join(shared, 'looptool'))
    } finally {
      restore()
    }
  })

  it('reads a POSIX PATH exactly as written, and a Windows one trimmed', () => {
    // ` /usr/bin` is a directory called ` /usr/bin` in the working directory to
    // `execvp`. Trimming it searched /usr/bin while the OS searched the checkout.
    expect(trustedSearchDirectories({ env: { PATH: ' /usr/bin:/bin' }, policyEnv: {}, platform: 'linux' })).toEqual(['/bin'])
    expect(trustedSearchDirectories({ env: { PATH: ' C:\\Tools ' }, policyEnv: { SystemRoot: 'relative' }, platform: 'win32' }))
      .toEqual(['C:\\Tools'])
  })

  itPosix('judges the path as written, so a link inside somebody else\'s directory is refused', () => {
    // The spawned path is the one written, and the OS follows the link in it
    // again at spawn time. A walk of the real path alone passed `/bin` reached
    // through a link that its owner could point anywhere.
    const root = tempRoot()
    const other = join(root, 'other')
    mkdirSync(other)
    symlinkSync('/bin', join(other, 'link'))
    const restore = ownedBySomeoneElse(other)
    try {
      const found = resolveTrustedExecutable('sh', { env: { PATH: join(other, 'link') }, policyEnv: {}, platform: 'linux', cache: freshCache() })
      expect(found.path).toBeUndefined()
      expect(found.reason).toContain(`${other}, above its directory,`)

      const named = resolveTrustedProgram(join(other, 'link', 'sh'), { policyEnv: {}, platform: 'linux' })
      expect(named.refusedAt).toBe(join(other, 'link', 'sh'))
    } finally {
      restore()
    }
  })

  itPosix('bounds the cache, dropping the oldest entry', () => {
    // Keyed per search list, and every project's pathPrepend is another one.
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const cache = freshCache()
    const filler = { path: tool, dev: 0, ino: 0, mtimeMs: 0, size: 0, candidate: tool, candidateIdentity: { dev: 0, ino: 0, mtimeMs: 0 }, directory: '/', extension: '' }
    for (let index = 0; index < 256; index += 1) cache.set(`filler-${index}`, filler)

    expect(findTrustedExecutablePath('looptool', { env: { PATH: join(root, 'bin') }, policyEnv: {}, platform: 'linux', cache })).toBe(tool)
    expect(cache.size).toBe(256)
    expect(cache.has('filler-0')).toBe(false)
    expect(cache.has('filler-1')).toBe(true)
  })

  it('knows when a bare-name spawn would look in the working directory', () => {
    // POSIX: only when PATH says so. A trailing colon, the everyday result of
    // `PATH=$PATH:`, says so.
    expect(bareNameSearchReachesWorkingDirectory({ PATH: '/usr/bin:/bin' }, 'linux')).toBe(false)
    expect(bareNameSearchReachesWorkingDirectory({ PATH: '/usr/bin:' }, 'linux')).toBe(true)
    expect(bareNameSearchReachesWorkingDirectory({ PATH: '.:/usr/bin' }, 'linux')).toBe(true)
    expect(bareNameSearchReachesWorkingDirectory({ PATH: ' /usr/bin' }, 'linux')).toBe(true)
    // Windows: always, whatever PATH says — libuv and CreateProcess look in the
    // current directory first — unless the spawning process opted out.
    expect(bareNameSearchReachesWorkingDirectory({ PATH: 'C:\\Windows' }, 'win32', {})).toBe(true)
    expect(bareNameSearchReachesWorkingDirectory({ PATH: 'C:\\Windows' }, 'win32', { NoDefaultCurrentDirectoryInExePath: '1' })).toBe(false)
    expect(bareNameSearchReachesWorkingDirectory({ PATH: 'C:\\Windows;tools' }, 'win32', { NoDefaultCurrentDirectoryInExePath: '1' })).toBe(true)
    // The opt-out is the spawning process's, so the child's does not count.
    expect(bareNameSearchReachesWorkingDirectory({ PATH: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' }, 'win32', {})).toBe(true)
  })
})

/**
 * What cmd.exe and then `CommandLineToArgvW` make of a line, written out so the
 * escaping can be checked off Windows. The Windows-only case below runs the real
 * thing.
 */
function cmdReads(line: string): string {
  let out = ''
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (character === '^') {
      out += line[index + 1] ?? ''
      index += 1
      continue
    }
    // Every quote is escaped, so cmd.exe never enters a quoted section; one that
    // is not escaped, or a live separator or expansion, is the bug under test.
    if ('"&|<>%!'.includes(character)) throw new Error(`cmd.exe would act on ${character} at ${index} in ${line}`)
    out += character
  }
  return out
}

function argvOf(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let started = false
  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index]!
    if (character === '\\') {
      let run = 0
      while (commandLine[index + run] === '\\') run += 1
      if (commandLine[index + run] === '"') {
        current += '\\'.repeat(Math.floor(run / 2))
        if (run % 2 === 1) current += '"'
        else inQuotes = !inQuotes
        index += run
      } else {
        current += '\\'.repeat(run)
        index += run - 1
      }
      started = true
    } else if (character === '"') {
      inQuotes = !inQuotes
      started = true
    } else if ((character === ' ' || character === '\t') && !inQuotes) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += character
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

const TRICKY_ARGUMENTS = [
  '',
  'plain',
  'with space',
  'a&b|c<d>e',
  '%PATH%',
  '!USERNAME!',
  '^caret^',
  '(paren) [bracket]',
  'semi;colon,comma',
  'star*question?',
  'back`tick',
  'C:\\Program Files\\',
  'trailing\\\\',
  'a\\"b',
  'a\\\\"b',
  'say "hi"',
  '"',
  '\\',
  'ünïcödé ✓',
]

describe('the cmd.exe launcher', () => {
  it('sends only command scripts through cmd.exe, and only on Windows', () => {
    expect(needsCommandInterpreter('C:\\nodejs\\npm.cmd', 'win32')).toBe(true)
    expect(needsCommandInterpreter('C:\\tools\\build.BAT', 'win32')).toBe(true)
    expect(needsCommandInterpreter('C:\\Git\\cmd\\git.exe', 'win32')).toBe(false)
    expect(needsCommandInterpreter('C:\\tools\\tool', 'win32')).toBe(false)
    expect(needsCommandInterpreter('/usr/bin/npm.cmd', 'linux')).toBe(false)
  })

  it('writes every argument so the program receives it unchanged', () => {
    // Includes the runs of backslashes before a quote and at the end that
    // cross-spawn 7.0.6 gets wrong: `trailing\\\\` arrived with one backslash and a quote.
    const launch = launchThroughInterpreter('C:\\Windows\\System32\\cmd.exe', 'C:\\Program Files\\nodejs\\npm.cmd', TRICKY_ARGUMENTS)
    expect(launch.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(launch.windowsVerbatimArguments).toBe(true)
    expect(launch.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    const line = launch.args[4]!
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true)

    const read = cmdReads(line.slice(1, -1))
    const program = 'C:\\Program Files\\nodejs\\npm.cmd '
    expect(read.startsWith(program)).toBe(true)
    expect(argvOf(read.slice(program.length))).toEqual(TRICKY_ARGUMENTS)
  })

  it('escapes a node_modules\\.bin shim twice, because the shim reads its line again', () => {
    const script = 'C:\\repo\\node_modules\\.bin\\eslint.cmd'
    const line = launchThroughInterpreter('cmd.exe', script, TRICKY_ARGUMENTS).args[4]!
    const firstRead = cmdReads(line.slice(1, -1))
    expect(firstRead.startsWith(`${script} `)).toBe(true)
    // The shim's own `%*` line is the second read.
    expect(argvOf(cmdReads(firstRead.slice(script.length + 1)))).toEqual(TRICKY_ARGUMENTS)
  })

  it('finds cmd.exe from the policy environment, never the child\'s', () => {
    const root = tempRoot()
    const trusted = makeExecutable(join(root, 'system'), 'cmd.exe')
    const planted = makeExecutable(join(root, 'planted'), 'cmd.exe')

    expect(resolveCommandInterpreter({ env: { ComSpec: planted }, policyEnv: { ComSpec: trusted }, platform: 'win32' }).path).toBe(trusted)
    expect(resolveCommandInterpreter({
      env: { ComSpec: planted, PATH: '' },
      policyEnv: { SystemRoot: '/nonexistent-windows-root' },
      platform: 'win32',
      cache: freshCache(),
    }).path).toBeUndefined()
  })

  it('plans a direct spawn for everything that is not a Windows command script', () => {
    expect(planProgramLaunch('/usr/bin/npm', ['ci'], { platform: 'linux' }))
      .toEqual({ file: '/usr/bin/npm', args: ['ci'], windowsVerbatimArguments: false })
    expect(planProgramLaunch('C:\\Git\\cmd\\git.exe', ['status'], { platform: 'win32' }))
      .toEqual({ file: 'C:\\Git\\cmd\\git.exe', args: ['status'], windowsVerbatimArguments: false })
  })

  it('plans a command script through the resolved cmd.exe, or says why it cannot', () => {
    const interpreter = () => ({ path: 'C:\\Windows\\System32\\cmd.exe' })
    const launch = planProgramLaunch('C:\\nodejs\\npm.cmd', ['ci'], { platform: 'win32', resolveInterpreter: interpreter })
    expect(launch.file).toBe('C:\\Windows\\System32\\cmd.exe')
    // A plain argument goes bare: quoted, `ci` would reach a batch file's `%1`
    // as `"ci"`, quotes and all.
    expect(launch.args?.[4]).toBe('"C:\\nodejs\\npm.cmd ci"')

    const missing = planProgramLaunch('C:\\nodejs\\npm.cmd', ['ci'], { platform: 'win32', resolveInterpreter: () => ({ reason: 'cmd.exe was not found.' }) })
    expect(missing.reason).toBe('C:\\nodejs\\npm.cmd is a command script, which needs cmd.exe to run, and cmd.exe could not be used: cmd.exe was not found.')

    // A line break ends a cmd.exe command line and drops what follows.
    const broken = planProgramLaunch('C:\\nodejs\\npm.cmd', ['one\ntwo'], { platform: 'win32', resolveInterpreter: interpreter })
    expect(broken.reason).toContain('cannot pass it an argument that contains a line break')
  })

  it('quotes only an argument that needs it, and turns delayed expansion off', () => {
    // Bare, a flag reaches a script comparing `if "%1"=="--version"` as itself.
    // Whitespace, a quote, a metacharacter, or the `=`, `,` and `;` a batch
    // file's `%1` splits on, and it is quoted and escaped as before.
    const launch = launchThroughInterpreter('cmd.exe', 'C:\\tools\\tool.cmd', ['--version', 'C:\\x\\y.tgz', 'a b', 'k=v', 'x;y', ''])
    expect(launch.args).toEqual(['/d', '/v:off', '/s', '/c', '"C:\\tools\\tool.cmd --version C:\\x\\y.tgz ^"a^ b^" ^"k=v^" ^"x^;y^" ^"^""'])
  })

  it('refuses a %…% reference cmd.exe would expand whatever the escaping', () => {
    const plan = (args: string[], env: NodeJS.ProcessEnv) => planProgramLaunch('C:\\nodejs\\npm.cmd', args, {
      platform: 'win32',
      env,
      resolveInterpreter: () => ({ path: 'C:\\Windows\\System32\\cmd.exe' }),
    })

    // The caret makes `%PATH%` a lookup of `PATH^`, which nothing defines.
    expect(plan(['%PATH%', '100%'], { PATH: 'C:\\Windows' }).reason).toBeUndefined()
    // Unless something does: Windows allows a caret in a name, and a plan
    // chooses its command's environment. Names are case-insensitive there.
    expect(plan(['%X%'], { 'x^': 'value & another-command' }).reason).toContain('would expand %X% in its arguments')
    // The edit forms look the name up before the colon, where no caret lands,
    // and dynamic names such as CD are in no environment at all.
    expect(plan(['%PATH:a=b%'], {}).reason).toContain('would expand %PATH:a=b%')
    expect(plan(['%CD:~0,2%'], {}).reason).toContain('would expand %CD:~0,2%')
    // Across arguments too: cmd.exe pairs the `%` wherever they are.
    expect(plan(['x%PATH:', 'a=b%'], {}).reason).toContain('would expand')
    // And a `%` that closed one reference can open the next: `%A%` finds
    // nothing, and cmd.exe may carry on from its second `%`.
    expect(plan(['%A%PATH:a=b%'], {}).reason).toContain('would expand %PATH:a=b%')
  })

  it('refuses a quote that would leave a metacharacter exposed to a script reading its line again', () => {
    const plan = (script: string, args: string[]) => planProgramLaunch(script, args, {
      platform: 'win32',
      env: {},
      resolveInterpreter: () => ({ path: 'C:\\Windows\\System32\\cmd.exe' }),
    })

    // npm's global shims pass `%*` on, and cmd.exe reads `\"` as a quote that
    // ends the quoted part, so ` & bye` would be a second command.
    expect(plan('C:\\Users\\dev\\AppData\\Roaming\\npm\\tool.cmd', ['say "hi & bye"']).reason)
      .toContain('a second time with part of it outside quotes')
    // A quote with nothing to act on outside it is carried as it is.
    expect(plan('C:\\Users\\dev\\AppData\\Roaming\\npm\\tool.cmd', ['description="hello"']).reason).toBeUndefined()
    // A `node_modules\\.bin` shim is escaped twice instead, so it is not refused.
    expect(plan('C:\\repo\\node_modules\\.bin\\tool.cmd', ['say "hi & bye"']).reason).toBeUndefined()
  })

  const onWindows = process.platform === 'win32' ? it : it.skip
  onWindows('round-trips every argument through the real cmd.exe', () => {
    // A shim that forwards `%*` to Node, as npm's do, in both places: a
    // `node_modules\\.bin` shim (escaped twice) and anywhere else (once). The
    // quote-bearing arguments go only to the first — a script elsewhere that
    // forwards `%*` re-reads a quote, which is the documented limit.
    const root = tempRoot()
    const body = `@"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`
    const shim = join(root, 'node_modules', '.bin', 'echoargs.cmd')
    const plain = join(root, 'tools', 'echo args.cmd')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(root, 'tools'), { recursive: true })
    writeFileSync(shim, body)
    writeFileSync(plain, body)
    const interpreter = resolveCommandInterpreter()
    expect(interpreter.path).toBeDefined()

    const run = (script: string, args: string[]): unknown => {
      const launch = launchThroughInterpreter(interpreter.path!, script, args)
      const result = spawnSync(launch.file, launch.args, { windowsVerbatimArguments: true, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    expect(run(shim, TRICKY_ARGUMENTS)).toEqual(TRICKY_ARGUMENTS)
    const quoteFree = TRICKY_ARGUMENTS.filter((arg) => !arg.includes('"'))
    expect(run(plain, quoteFree)).toEqual(quoteFree)

    // A script reading `%1` itself sees a plain argument exactly as written.
    const first = join(root, 'tools', 'first.cmd')
    writeFileSync(first, '@echo [%1]\r\n')
    const launch = launchThroughInterpreter(interpreter.path!, first, ['--version'])
    const echoed = spawnSync(launch.file, launch.args, { windowsVerbatimArguments: true, encoding: 'utf8' })
    expect(echoed.stdout.trim()).toBe('[--version]')
  })
})
