import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface FixtureRepoManager {
  createRepo(prefix?: string): string
  cleanup(): void
}

function writeFixtureFiles(rootDir: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolve(rootDir, relativePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
}

function initializeGitRepo(repoDir: string) {
  execFileSync('git', ['-C', repoDir, 'init'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'LoopTroop Tests'], { stdio: 'pipe' })
  // Git for Windows defaults to autocrlf=true and would rewrite fixture content
  // on checkout, so byte-for-byte assertions fail there and nowhere else.
  execFileSync('git', ['-C', repoDir, 'config', 'core.autocrlf', 'false'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'core.eol', 'lf'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'branch', '-M', 'main'], { stdio: 'pipe' })
}

/** Windows holds briefly onto files just released, so removal needs retries. */
function removeTree(target: string) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

export function createFixtureRepoManager(options: {
  templatePrefix: string
  files: Record<string, string>
}): FixtureRepoManager {
  const templateRoot = mkdtempSync(join(tmpdir(), options.templatePrefix))
  const templateRepo = resolve(templateRoot, 'repo')
  const repoDirs = new Set<string>()

  mkdirSync(templateRepo, { recursive: true })
  writeFixtureFiles(templateRepo, options.files)
  initializeGitRepo(templateRepo)

  return {
    createRepo(prefix = options.templatePrefix) {
      const repoDir = mkdtempSync(join(tmpdir(), prefix))
      removeTree(repoDir)
      cpSync(templateRepo, repoDir, { recursive: true })
      repoDirs.add(repoDir)
      return repoDir
    },
    cleanup() {
      for (const repoDir of repoDirs) {
        removeTree(repoDir)
      }
      repoDirs.clear()
      removeTree(templateRoot)
    },
  }
}
