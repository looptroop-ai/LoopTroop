import { execFile } from 'node:child_process'
import { promises as fs, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { ContainedPathError, resolveContainedPath } from './containedPath'
import { resolveTrustedExecutable } from './executablePath'

const execFileAsync = promisify(execFile)

export function encodedInvokeItem(targetPath: string): string {
  const encodedPath = Buffer.from(targetPath, 'utf16le').toString('base64')
  // Encode the data separately: PowerShell also treats Unicode smart quotes as
  // delimiters, so escaping ASCII apostrophes alone does not keep filenames literal.
  const script = `Invoke-Item -LiteralPath ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')))`
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** The platform openers accept names, not directory handles; a residual swap window remains. */
export async function revealFolderInExplorer(targetPath: string, allowedRoots: string[]): Promise<void> {
  if (!isAbsolute(targetPath) || targetPath.includes('\0')) throw new ContainedPathError('Path must be absolute and inside an attached project or the LoopTroop application configuration directory')
  let requestedPath: string
  try {
    requestedPath = realpathSync.native(targetPath)
  } catch {
    throw new ContainedPathError('Path must exist inside an attached project or the LoopTroop application configuration directory')
  }
  let root: string | undefined
  let target: string | undefined
  for (const allowedRoot of allowedRoots) {
    try {
      const canonicalRoot = realpathSync.native(allowedRoot)
      const contained = resolveContainedPath(canonicalRoot, requestedPath)
      root = canonicalRoot
      target = contained
      break
    } catch {
      // An unavailable project cannot authorize a path. Try the other stored roots.
    }
  }
  if (!root || !target) throw new ContainedPathError('Path must exist inside an attached project or the LoopTroop application configuration directory')
  const folder = statSync(target).isDirectory() ? target : dirname(target)
  const trustedRoot = root

  async function runOpener(name: string, args: string[]): Promise<{ stdout: string }> {
    const resolution = resolveTrustedExecutable(name)
    if (resolution.path === undefined) throw new Error(resolution.reason)
    if (realpathSync.native(trustedRoot) !== trustedRoot
      || resolveContainedPath(trustedRoot, folder) !== folder) {
      throw new ContainedPathError('Path changed before it could be opened')
    }
    return execFileAsync(resolution.path, args)
  }

  const isWsl = process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP
    || await fs.readFile('/proc/version', 'utf8').then(v => v.toLowerCase().includes('microsoft')).catch(() => false)
  )
  if (isWsl) {
    // The trusted system translator maps the contained Linux name to Windows.
    // Strip its terminator only: whitespace can belong to the actual filename.
    const { stdout } = await runOpener('wslpath', ['-w', folder])
    const windowsFolder = stdout.replace(/\r?\n$/, '')
    if (!windowsFolder || /[\r\n\0]/.test(windowsFolder)) throw new ContainedPathError('Invalid translated folder path')
    try {
      await runOpener('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedInvokeItem(windowsFolder)])
    } catch (error) {
      if (error instanceof ContainedPathError) throw error
      await runOpener('explorer.exe', [windowsFolder])
    }
  } else {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    await runOpener(opener, [folder])
  }
}
