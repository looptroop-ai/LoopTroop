/**
 * The `docker` calls the container release makes, and the two rules every one of
 * them follows: a registry read that fails for an unrecognised reason ends the
 * run, and a failure says why on the run summary rather than only in the log.
 *
 * Separated from ./container-tags.ts, which decides things and is tested, and
 * from the three scripts that drive it. Kept in one place because the release
 * run and the repair dispatch make the same calls, and because a second copy of
 * "is this failure an absence?" is a second thing to get wrong.
 */
import { spawnSync } from 'node:child_process'

import { DIGEST_PATTERN, classifyRegistryFailure } from './container-tags.ts'

export interface DockerResult {
  /** null when docker could not be executed at all. */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs `docker` and hands back what it said, without throwing.
 *
 * `shell: false`, so nothing here can be word-split or glob-expanded; image
 * references and digests are passed as argv entries.
 */
export function docker(args: string[]): DockerResult {
  const result = spawnSync('docker', args, { encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 })
  if (result.error) {
    return { code: null, stdout: '', stderr: String(result.error.message) }
  }
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

/**
 * Ends the run with a workflow annotation, so the reason appears on the run
 * summary and in the failure issue rather than only partway down a log.
 */
export function fatal(message: string, detail = ''): never {
  process.stdout.write(`::error::${message}\n`)
  if (detail.trim() !== '') process.stdout.write(`${detail.trimEnd()}\n`)
  process.exit(1)
}

/** Absence is a distinct answer from a digest, and never from an error. */
export const ABSENT = 'absent'

/**
 * The index digest a reference resolves to, or `ABSENT` when the registry
 * genuinely has nothing there.
 *
 * Anything else ends the run. Nothing is run under `2>/dev/null`: an expired
 * token, a DNS failure and Docker Hub's anonymous rate limit all fail the same
 * read that a missing tag fails, and treating them alike would read a transient
 * error as permission to overwrite a released tag.
 */
export function resolveDigest(reference: string): string {
  const result = docker(['buildx', 'imagetools', 'inspect', '--format', '{{.Manifest.Digest}}', reference])
  const digest = result.stdout.trim()
  if (result.code === 0 && DIGEST_PATTERN.test(digest)) return digest
  if (result.code === 0) {
    fatal(`${reference} resolved to '${digest}', which is not a digest.`, result.stderr)
  }
  if (classifyRegistryFailure(result.stderr) === 'absent') return ABSENT
  fatal(`Could not resolve ${reference}, and the reason is not that it is absent (exit ${result.code}).`, result.stderr)
}

/** The raw manifest bytes a reference serves, or null for a genuine absence. */
export function inspectRaw(reference: string): string | null {
  const result = docker(['buildx', 'imagetools', 'inspect', '--raw', reference])
  if (result.code === 0) return result.stdout
  if (classifyRegistryFailure(result.stderr) === 'absent') return null
  fatal(
    `Could not read ${reference}, and the reason is not that it is absent (exit ${result.code}).`,
    `--- stderr\n${result.stderr}\n--- stdout\n${result.stdout}`,
  )
}

/**
 * A digest that must be present, for the steps where an absence is itself the
 * failure rather than a state to branch on.
 */
export function requireDigest(reference: string): string {
  const digest = resolveDigest(reference)
  if (digest === ABSENT) {
    fatal(`${reference} does not exist.`)
  }
  return digest
}
