import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { clearProjectDatabaseCache } from '../db/project'
import { canonicalTmpdir, disableGitAutoMaintenance } from './tempDir'

function closeProjectDatabases() {
  try {
    clearProjectDatabaseCache()
  } catch {
    // Nothing was opened, which is the common case for pure tests.
  }
}

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
  execFileSync('git', ['-C', repoDir, 'init', '--initial-branch=main'], { stdio: 'pipe' })
  disableGitAutoMaintenance(repoDir)
  // Appended rather than set with `git config`, which takes one process per key.
  // Git for Windows defaults to autocrlf=true and would rewrite fixture content
  // on checkout, so byte-for-byte assertions fail there and nowhere else.
  appendFileSync(
    join(repoDir, '.git', 'config'),
    '[user]\n\temail = test@example.com\n\tname = LoopTroop Tests\n[core]\n\tautocrlf = false\n\teol = lf\n',
  )
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' })
}

/** Windows holds briefly onto files just released, so removal needs retries. */
function removeTree(target: string) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

export function createFixtureRepoManager(options: {
  templatePrefix: string
  files: Record<string, string>
}): FixtureRepoManager {
  const templateRoot = mkdtempSync(join(canonicalTmpdir(), options.templatePrefix))
  const templateRepo = resolve(templateRoot, 'repo')
  const repoDirs = new Set<string>()

  mkdirSync(templateRepo, { recursive: true })
  writeFixtureFiles(templateRepo, options.files)
  initializeGitRepo(templateRepo)

  return {
    createRepo(prefix = options.templatePrefix) {
      const repoDir = mkdtempSync(join(canonicalTmpdir(), prefix))
      removeTree(repoDir)
      cpSync(templateRepo, repoDir, { recursive: true })
      repoDirs.add(repoDir)
      return repoDir
    },
    cleanup() {
      // Windows refuses to unlink an open file, and each fixture repo may hold
      // a cached project database handle.
      closeProjectDatabases()
      for (const repoDir of repoDirs) {
        removeTree(repoDir)
      }
      repoDirs.clear()
      removeTree(templateRoot)
    },
  }
}
