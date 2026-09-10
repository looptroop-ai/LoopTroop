import { chmodSync, chownSync, mkdirSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import {
  findTrustedExecutablePath,
  requireTrustedExecutablePath,
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

function tempRoot(): string {
  const root = makeTempDir('executable-path-')
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
  const uid = process.getuid?.() ?? 0
  const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
  return () => spy.mockRestore()
}

const posix = process.platform !== 'win32'
/** The mode bits are the check; NTFS reports 0777 for everything and cannot express these. */
const itPosix = posix ? it : it.skip
/** Cases that need one foreign path among trusted ones, which only root can arrange. */
const itAsRoot = posix && process.getuid?.() === 0 ? it : it.skip

describe('trustedSearchDirectories', () => {
  it('prepends the override, and does not use it to filter PATH', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['/usr/bin', '/usr/local/bin'].join(delimiter), [TRUSTED_EXECUTABLE_DIRS_ENV]: '/opt/tools' },
    })

    // Prepended: an operator naming a directory is answering "the tool is not
    // on PATH", which filtering PATH by the same value cannot serve.
    expect(directories).toEqual(['/opt/tools', '/usr/bin', '/usr/local/bin'])
  })

  it('drops the empty segment, the current directory and relative entries', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['', '.', '..', 'relative/bin', '/usr/bin'].join(delimiter) },
    })

    expect(directories).toEqual(['/usr/bin'])
  })

  it('keeps the first occurrence of a directory named twice', () => {
    const directories = trustedSearchDirectories({
      env: { PATH: ['/usr/bin', '/usr/local/bin', '/usr/bin/'].join(delimiter) },
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
    })).toEqual({ path: tool })
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
      expect(resolution.reason).toContain('neither root nor you')
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
      env: { PATH: '/nonexistent', [TRUSTED_EXECUTABLE_DIRS_ENV]: join(root, 'opt') },
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
        env: { PATH: '', [TRUSTED_EXECUTABLE_DIRS_ENV]: shared },
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
  itPosix('trusts the directory the link is in, not the store it points at', () => {
    // Homebrew and Nix both put a link in a trusted directory pointing into a
    // store that no trust list would ever name. Checking the target's directory
    // would refuse both.
    const root = tempRoot()
    const store = join(root, 'nix', 'store', 'abcdef-git-2.51.0', 'bin')
    const target = makeExecutable(store, 'git')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(target, join(bin, 'git'))

    expect(findTrustedExecutablePath('git', {
      env: { PATH: bin },
      platform: 'linux',
      cache: freshCache(),
    })).toBe(target)
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
  function windowsEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { PATH: join(root, 'bin'), USERPROFILE: root, ...extra }
  }

  it('applies PATHEXT to a bare name', () => {
    const root = tempRoot()
    // `.EXE` before `.CMD` in PATHEXT, and the .CMD exists too: the order in the
    // variable is what decides, exactly as CreateProcess would not.
    makeExecutable(join(root, 'bin'), 'tool.CMD')
    const exe = makeExecutable(join(root, 'bin'), 'tool.EXE')

    expect(findTrustedExecutablePath('tool', {
      env: windowsEnv(root, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
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
      env: windowsEnv(root, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
      platform: 'win32',
      cache: freshCache(),
    })).toBe(shim)
  })

  it('honours an extension already present in the name', () => {
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'bin'), 'powershell.EXE')

    expect(findTrustedExecutablePath('powershell.EXE', {
      env: windowsEnv(root, { PATHEXT: '.COM;.EXE' }),
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
      env: { PATH: join(root, 'hostedtoolcache', 'node', 'x64'), PATHEXT: '.EXE;.CMD' },
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
        SystemRoot: 'C:\\Windows',
        PATH: ['C:\\Tools\\', '"C:\\Program Files\\nodejs"', '', '.', 'relative\\bin', 'c:\\windows\\system32'].join(win32.delimiter),
      },
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
    expect(trustedSearchDirectories({ env: { SystemRoot: 'C:\\Windows', PATH: '/usr/bin' }, platform: 'linux' }))
      .toEqual(['/usr/bin'])
  })

  it('strips the quotes Windows tolerates around a PATH entry', () => {
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'bin'), 'tool.EXE')

    expect(findTrustedExecutablePath('tool', {
      env: { PATH: `"${join(root, 'bin')}"`, USERPROFILE: root, PATHEXT: '.EXE' },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
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
      }).reason).toContain('neither root nor you')
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
      }).reason).toContain('neither root nor you')
    } finally {
      restore()
    }
  })

  itPosix('decodes the octal escapes /proc/mounts uses for a space', () => {
    const root = tempRoot()
    const mountPoint = join(root, 'my drive')
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
    // that a cache watching only the target kept spawning version 1.0 forever.
    const root = tempRoot()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const oldTarget = makeExecutable(join(root, 'store', '1.0'), 'git')
    symlinkSync(oldTarget, join(bin, 'git'))
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('git', options)).toBe(oldTarget)

    const newTarget = makeExecutable(join(root, 'store', '2.0'), 'git')
    symlinkSync(newTarget, join(bin, 'git.new'))
    renameSync(join(bin, 'git.new'), join(bin, 'git'))

    expect(findTrustedExecutablePath('git', options)).toBe(newTarget)
    expect(statSync(oldTarget).isFile()).toBe(true)
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
      expect(resolveTrustedExecutable('looptool', options).reason).toContain('neither root nor you')
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
      env: { PATH: join(root, 'bin'), USERPROFILE: root, PATHEXT: '.EXE' },
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

    expect(resolveTrustedProgram(tool, { platform: 'linux' })).toEqual({ path: tool })
  })
})
