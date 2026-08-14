#!/usr/bin/env node
/**
 * Decides whether a release run may publish.
 *
 *   node scripts/release-guard.mjs
 *
 * Reads `GITHUB_EVENT_NAME`, `GITHUB_REF`, `REQUESTED` and `SKIP_BINARIES`, and
 * writes `dry_run` and `skip_binaries` to `GITHUB_OUTPUT`.
 *
 * This lived as fifteen lines of shell inside `release.yml`, which meant the one
 * decision that separates "built and verified" from "published to seven
 * registries" could not be tested. It was also wrong twice in a row: once
 * because a boolean input arrives as the *string* `"false"` and is therefore
 * truthy in a GitHub expression, and once because every manual dispatch was
 * forced to a dry run — which made the `skip_binaries` escape hatch unusable, an
 * input that could be set for a release that could never happen.
 *
 * So the rule is a pure function with tests, and the workflow just calls it.
 */

/**
 * The one place that says when publishing is allowed.
 *
 * Publishing happens on a push to `main`, and on exactly one manual route: the
 * emergency bypass for a runner-class outage, which needs the `main` ref, an
 * explicit `dry_run=false` *and* `skip_binaries=true` together. Everything else
 * is a dry run, including a dispatch that merely asks not to be one.
 */
export function resolveGuard({ event, ref, requested, skipBinaries }) {
  const onMain = ref === 'refs/heads/main'
  // Only a dispatch can ask for the bypass: `workflow_dispatch` inputs do not
  // exist on a push, so the ordinary path cannot reach it even by accident.
  const bypass = event === 'workflow_dispatch' && skipBinaries === 'true'

  if (event === 'push' && onMain) {
    return { dryRun: false, skipBinaries: false, notes: [] }
  }

  if (bypass && onMain && requested === 'false') {
    return {
      dryRun: false,
      skipBinaries: true,
      notes: ['Publishing from a manual dispatch, because skip_binaries was requested.'],
    }
  }

  const notes = []
  if (requested === 'false') {
    notes.push(`A real publish was requested, but this is ${event} on ${ref}.`)
    notes.push(bypass
      ? 'The binary bypass publishes only from refs/heads/main.'
      : 'Forcing a dry run. Publishing happens only on a push to refs/heads/main.')
  }

  return { dryRun: true, skipBinaries: bypass, notes }
}

// Only when run as a program; the tests import `resolveGuard` directly.
if (process.env.GITHUB_ACTIONS === 'true' || process.argv[2] === '--emit') {
  const { appendFileSync } = await import('node:fs')

  const guard = resolveGuard({
    event: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    requested: process.env.REQUESTED ?? '',
    skipBinaries: process.env.SKIP_BINARIES ?? '',
  })

  for (const note of guard.notes) process.stdout.write(`::warning::${note}\n`)
  const lines = `dry_run=${guard.dryRun}\nskip_binaries=${guard.skipBinaries}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  process.stdout.write(`Dry run: ${guard.dryRun}\nSkip binaries: ${guard.skipBinaries}\n`)
}
