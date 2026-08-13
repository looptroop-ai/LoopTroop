#!/usr/bin/env node
/**
 * Runs Homebrew's own checks against the formula this release would publish.
 *
 *   node scripts/audit-formula.ts --version 9.9.9 --url https://… --sha256 … [--online]
 *
 * Before the push, never after: the tap has no CI of its own, so an objection
 * discovered afterwards is already published. `--online` additionally fetches
 * the URL and verifies the checksum, which is only meaningful once the release
 * assets exist — CI runs this offline against a release-shaped formula, and the
 * publish job runs it online against the real one.
 *
 * In a throwaway tap because `brew audit` will not look at a formula that is
 * not in one, and the public tap must not be touched by a check.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHomebrewFormula } from './package-manifests.ts'
import { createLocalTap, removeLocalTap } from './brew-local-tap.ts'

const AUDIT_TAP = 'looptroop-ai/audit' as const

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

function brew(args: string[], allowFailure = false): string {
  try {
    return execFileSync('brew', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFailure) return ''
    const shown = error instanceof Error && 'stdout' in error
      ? `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`
      : String(error)
    fail(`brew ${args[0]} objected to the formula.`, shown.trim())
  }
}

const formula = renderHomebrewFormula({ version: flag('version'), url: flag('url'), sha256: flag('sha256') })

const tapDir = createLocalTap(AUDIT_TAP)
writeFileSync(join(tapDir, 'Formula', 'looptroop.rb'), formula)

try {
  process.stdout.write('brew style...\n')
  process.stdout.write(brew(['style', `${AUDIT_TAP}/looptroop`]))

  process.stdout.write('brew audit --strict...\n')
  process.stdout.write(brew([
    'audit', '--strict', '--formula',
    ...(process.argv.includes('--online') ? ['--online'] : []),
    `${AUDIT_TAP}/looptroop`,
  ]))

  process.stdout.write('\nPASS: Homebrew has no objection to the formula.\n')
} finally {
  removeLocalTap(AUDIT_TAP)
}
