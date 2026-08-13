#!/usr/bin/env node
/**
 * Submits the built package to the Chocolatey community feed.
 *
 *   CHOCOLATEY_API_KEY=… node scripts/choco-push.ts --nupkg dist-choco/looptroop.9.9.9.nupkg --version 9.9.9
 *
 * "Submitted" is as far as this can get. The community feed moderates every
 * package, the queue has no deadline, and nothing else in the release waits for
 * it — so a package accepted for review is a success here, and whether it went
 * live is a separate question answered by a dispatch after the fact.
 *
 * Re-running a release that failed after this step finds the version already on
 * the feed. That is also a success: a Chocolatey version is immutable once
 * accepted, so there is nothing to retry.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyChocoPush } from './channel-state.ts'

const PUSH_SOURCE = 'https://push.chocolatey.org/'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

const nupkg = resolve(flag('nupkg'))
const version = flag('version')
if (!existsSync(nupkg)) fail(`No package at ${nupkg}.`)

const apiKey = process.env.CHOCOLATEY_API_KEY ?? ''
if (apiKey === '') fail('CHOCOLATEY_API_KEY is not set.', 'It lives in the `packaging` environment.')

/**
 * Runs choco and returns everything it said, never echoing the command.
 *
 * The API key is an argument — Chocolatey has no environment variable for it —
 * and although Actions masks registered secrets, a script that prints its own
 * argv is one misconfiguration away from publishing a credential.
 */
function choco(args: string[]): { status: number | null, output: string } {
  const result = spawnSync('choco', args, { encoding: 'utf8', shell: true })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// Registered against the source first so the push itself carries no key.
const registered = choco(['apikey', 'add', '--source', PUSH_SOURCE, '--api-key', apiKey, '--limit-output'])
if (registered.status !== 0) fail('Chocolatey refused the API key.', registered.output.trim())

const pushed = choco(['push', nupkg, '--source', PUSH_SOURCE, '--timeout', '600'])
const outcome = classifyChocoPush(pushed.status, pushed.output)
process.stdout.write(pushed.output)

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${outcome.state}\n`)

switch (outcome.state) {
  case 'submitted':
    log(`\nlooptroop ${version} is submitted and waiting for moderation.`)
    log('Moderation has no deadline and nothing else in the release waits for it.')
    log('Once it clears, dispatch channel-republish.yml with channel=chocolatey to verify it installs from the feed.')
    break
  case 'already-published':
    log(`\nlooptroop ${version} is already on the feed; nothing to do.`)
    break
  case 'failed':
    fail(`Pushing looptroop ${version} to Chocolatey failed: ${outcome.reason}`)
}
