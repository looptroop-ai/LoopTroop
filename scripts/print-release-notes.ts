#!/usr/bin/env node
/**
 * Prints release notes for a version to stdout, for the release workflow.
 *
 * Usage: node scripts/print-release-notes.ts [version]
 * Defaults to the current package.json version.
 */
import { readFileSync } from 'node:fs'
import { extractReleaseNotes } from './changelog-release-notes.ts'

const requested = process.argv[2]?.trim()
const version = requested || JSON.parse(readFileSync('package.json', 'utf8')).version

try {
  process.stdout.write(`${extractReleaseNotes('CHANGELOG.md', version)}\n`)
} catch (error) {
  console.error(`[release-notes] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
