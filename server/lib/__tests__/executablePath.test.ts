import { chmodSync, mkdirSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import {
  findTrustedExecutablePath,
  requireTrustedExecutablePath,
  resolveTrustedExecutable,
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

const posix = process.platform !== 'win32'
/** The mode bits are the check; NTFS reports 0777 for everything and cannot express these. */
const itPosix = posix ? it : it.skip

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

  itPosix('refuses a hit in a world-writable directory instead of walking past it', () => {
    // Walking on would resolve to a *different* program than the operating
    // system would have run, which is a worse answer than refusing.
    const root = tempRoot()
    const open = join(root, 'open')
    const later = join(root, 'later')
    makeExecutable(open, 'looptool')
    makeExecutable(later, 'looptool')
    chmodSync(open, 0o777)

    const resolution = resolveTrustedExecutable('looptool', {
      env: { PATH: [open, later].join(delimiter) },
      platform: 'linux',
      cache: freshCache(),
    })

    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain('writable by any user')
    expect(resolution.reason).toContain(TRUSTED_EXECUTABLE_DIRS_ENV)
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

  itPosix('does not let the override excuse a world-writable directory', () => {
    // The override says where to look. It is not a claim that the daemon should
    // stop checking, and an operator can point it at /tmp by accident.
    const root = tempRoot()
    const open = join(root, 'open')
    makeExecutable(open, 'looptool')
    chmodSync(open, 0o777)

    expect(resolveTrustedExecutable('looptool', {
      env: { PATH: '', [TRUSTED_EXECUTABLE_DIRS_ENV]: open },
      platform: 'linux',
      cache: freshCache(),
    }).reason).toContain('writable by any user')
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

  it('refuses a directory outside the system and profile roots', () => {
    const root = tempRoot()
    makeExecutable(join(root, 'scratch'), 'tool.EXE')

    expect(resolveTrustedExecutable('tool', {
      // USERPROFILE deliberately elsewhere: the tool is in neither a system
      // root nor this user's own tree.
      env: { PATH: join(root, 'scratch'), USERPROFILE: join(root, 'profile'), PATHEXT: '.EXE' },
      platform: 'win32',
      cache: freshCache(),
    }).reason).toContain('outside the system and user-profile directories')
  })

  it('accepts a version manager under the user profile', () => {
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'scoop', 'shims'), 'gh.EXE')

    expect(findTrustedExecutablePath('gh', {
      env: { PATH: join(root, 'scoop', 'shims'), USERPROFILE: root, PATHEXT: '.EXE' },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('trusts a directory the operator named outright', () => {
    // On Windows the override is the *only* signal available for a tool in an
    // unusual place: NTFS reports mode 0777 for everything, so there is no
    // permission check to fall back on. On POSIX there is, and the override does
    // not excuse it — the case above proves that half.
    const root = tempRoot()
    const exe = makeExecutable(join(root, 'tools'), 'gh.EXE')

    expect(findTrustedExecutablePath('gh', {
      env: {
        PATH: '',
        [TRUSTED_EXECUTABLE_DIRS_ENV]: join(root, 'tools'),
        USERPROFILE: join(root, 'profile'),
        PATHEXT: '.EXE',
      },
      platform: 'win32',
      cache: freshCache(),
    })).toBe(exe)
  })

  it('does not treat a sibling of a trusted root as inside it', () => {
    // `C:\Users\bob-scratch` starts with `C:\Users\bob`, and a startsWith test
    // is the whole check defeated by naming a directory carefully.
    const root = tempRoot()
    makeExecutable(`${join(root, 'profile')}-scratch`, 'tool.EXE')

    expect(resolveTrustedExecutable('tool', {
      env: { PATH: `${join(root, 'profile')}-scratch`, USERPROFILE: join(root, 'profile'), PATHEXT: '.EXE' },
      platform: 'win32',
      cache: freshCache(),
    }).reason).toContain('outside the system and user-profile directories')
  })

  it('ignores an empty ProgramFiles rather than turning it into the working directory', () => {
    // `resolve('')` is the current working directory, so an unset-but-present
    // variable once made the whole checkout a trusted root.
    const root = tempRoot()
    makeExecutable(join(root, 'scratch'), 'tool.EXE')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'scratch'))
    try {
      expect(resolveTrustedExecutable('tool', {
        env: {
          PATH: join(root, 'scratch'),
          USERPROFILE: join(root, 'profile'),
          ProgramFiles: '',
          PATHEXT: '.EXE',
        },
        platform: 'win32',
        cache: freshCache(),
      }).reason).toContain('outside the system and user-profile directories')
    } finally {
      cwd.mockRestore()
    }
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
  itPosix('accepts a world-writable directory that is on a Windows drive mount', () => {
    // DrvFs reports 0777 for everything it shows. Without this, every WSL
    // developer's Windows-side git is refused on day one.
    const root = tempRoot()
    const bin = join(root, 'bin')
    const tool = makeExecutable(bin, 'git.exe')
    chmodSync(bin, 0o777)

    expect(findTrustedExecutablePath('git.exe', {
      env: { PATH: bin },
      platform: 'linux',
      readMountTable: () => `/dev/sda1 / ext4 rw 0 0\nC:\\ ${root} drvfs rw 0 0\n`,
      cache: freshCache(),
    })).toBe(tool)
  })

  itPosix('does not extend the exception to a real filesystem below the mount', () => {
    // The longest matching mount point wins, as the kernel resolves it. A path
    // that merely *looks* like it is under /mnt is not the test.
    const root = tempRoot()
    const bin = join(root, 'inner', 'bin')
    makeExecutable(bin, 'git')
    chmodSync(bin, 0o777)

    expect(resolveTrustedExecutable('git', {
      env: { PATH: bin },
      platform: 'linux',
      readMountTable: () => `C:\\ ${root} drvfs rw 0 0\n/dev/sdb1 ${join(root, 'inner')} ext4 rw 0 0\n`,
      cache: freshCache(),
    }).reason).toContain('writable by any user')
  })

  itPosix('treats an unreadable mount table as "not WSL"', () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    makeExecutable(bin, 'git')
    chmodSync(bin, 0o777)

    expect(resolveTrustedExecutable('git', {
      env: { PATH: bin },
      platform: 'linux',
      readMountTable: () => '',
      cache: freshCache(),
    }).reason).toContain('writable by any user')
  })

  itPosix('decodes the octal escapes /proc/mounts uses for a space', () => {
    const root = tempRoot()
    const mountPoint = join(root, 'my drive')
    const tool = makeExecutable(mountPoint, 'git.exe')
    chmodSync(mountPoint, 0o777)

    expect(findTrustedExecutablePath('git.exe', {
      env: { PATH: mountPoint },
      platform: 'linux',
      readMountTable: () => `C:\\ ${mountPoint.replace(/ /g, '\\040')} drvfs rw 0 0\n`,
      cache: freshCache(),
    })).toBe(tool)
  })
})

describe('the resolution cache', () => {
  itPosix('answers the second call without walking PATH again', () => {
    const root = tempRoot()
    const tool = makeExecutable(join(root, 'bin'), 'looptool')
    const cache = freshCache()
    const options = { env: { PATH: join(root, 'bin') }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('looptool', options)).toBe(tool)
    expect(cache.size).toBe(1)

    // PATH now points nowhere: only the cache can still answer.
    expect(findTrustedExecutablePath('looptool', { ...options, env: { PATH: join(root, 'bin') } })).toBe(tool)
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

  itPosix('re-resolves when a symlink target was swapped during an upgrade', () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const oldTarget = makeExecutable(join(root, 'store', '1.0'), 'git')
    symlinkSync(oldTarget, join(bin, 'git'))
    const cache = freshCache()
    const options = { env: { PATH: bin }, platform: 'linux' as const, cache }

    expect(findTrustedExecutablePath('git', options)).toBe(oldTarget)

    const newTarget = makeExecutable(join(root, 'store', '2.0'), 'git')
    // An atomic swap of the link: the name in `bin` is unchanged, the file the
    // daemon cached is not the one it now points at.
    symlinkSync(newTarget, join(bin, 'git.new'))
    renameSync(join(bin, 'git.new'), join(bin, 'git'))
    unlinkSync(oldTarget)

    expect(findTrustedExecutablePath('git', options)).toBe(newTarget)
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
