import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'
import {
  classifyAuditMaintenanceFailure,
  chooseAgedDependencyTarget,
  collectLockfilePackageUpdates,
  decideDailyMaintenanceTask,
  formatDependencyReleasePolicySummaryLines,
  evaluatePackageVersionReleaseAge,
  formatDependencyUpdateReleaseDetail,
  formatHeldAuditPackageUpdate,
  formatHeldDependencyReleaseDetail,
  formatUpdatedDependencyRange,
  getAuditStartupDisposition,
  getDependencyUpdateReleaseDetails,
  getHeldAuditPackageReleaseDetails,
  getHeldDependencyReleaseDetails,
  getRegistryHostedRemotePolicyFailureUrl,
  getStandaloneAuditExitCode,
  isExpectedAuditFindingsExit,
  isPeerResolutionFailure,
  parseNpmViewPublishTimes,
  recordDailyMaintenanceSuccess,
  shouldRetryAuditMaintenanceFailure,
  summarizePeerResolutionFailure,
  type DailyMaintenanceState,
} from '../scripts/dev-maintenance'

const tempDirs: string[] = []

function createState(): DailyMaintenanceState {
  return {
    version: 1,
    tasks: {},
  }
}

function makeTempFile(contents = 'x') {
  const dir = makeTempDir('looptroop-dev-maintenance-')
  tempDirs.push(dir)
  const filePath = join(dir, 'marker.txt')
  writeFileSync(filePath, contents, 'utf8')
  return filePath
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      removeTempDir(dir)
    }
  }
})

describe('daily dev maintenance decisions', () => {
  it('runs when the task has never completed before', () => {
    const decision = decideDailyMaintenanceTask({
      taskName: 'audit',
      state: createState(),
      now: new Date('2026-04-23T10:00:00'),
    })

    expect(decision.shouldRun).toBe(true)
    expect(decision.reason).toBe('never-ran')
    expect(decision.deferred).toBe(false)
  })

  it('defers when the task already completed earlier on the same local day', () => {
    const state = createState()
    recordDailyMaintenanceSuccess(state, 'opencode', new Date('2026-04-23T09:00:00'))

    const decision = decideDailyMaintenanceTask({
      taskName: 'opencode',
      state,
      now: new Date('2026-04-23T18:00:00'),
    })

    expect(decision.shouldRun).toBe(false)
    expect(decision.deferred).toBe(true)
    expect(decision.reason).toBe('already-ran-today')
    expect(decision.lastCompletedAt).toBeDefined()
    expect(decision.nextEligibleAt).toBeDefined()
  })

  it('runs again the same day when a watched file changed after the last completion', async () => {
    const markerPath = makeTempFile('before')
    const state = createState()
    recordDailyMaintenanceSuccess(state, 'dependencySync', new Date('2026-04-23T09:00:00'))
    writeFileSync(markerPath, 'after', 'utf8')

    const decision = decideDailyMaintenanceTask({
      taskName: 'dependencySync',
      state,
      now: new Date('2026-04-23T18:00:00'),
      invalidatedByPaths: [markerPath],
    })

    expect(decision.shouldRun).toBe(true)
    expect(decision.deferred).toBe(false)
    expect(decision.reason).toBe('invalidated')
  })

  it('runs again on a new local day even without invalidation', () => {
    const state = createState()
    recordDailyMaintenanceSuccess(state, 'audit', new Date('2026-04-23T22:00:00'))

    const decision = decideDailyMaintenanceTask({
      taskName: 'audit',
      state,
      now: new Date('2026-04-24T09:00:00'),
    })

    expect(decision.shouldRun).toBe(true)
    expect(decision.reason).toBe('new-day')
    expect(decision.deferred).toBe(false)
  })
})

describe('audit maintenance failure policy', () => {
  it('defers malformed registry responses without allowing them to block startup', () => {
    const failure = classifyAuditMaintenanceFailure(
      'npm warn audit invalid json response body at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      'registry_command',
    )

    expect(failure).toMatchObject({
      kind: 'invalid_registry_response',
      startupBlocking: false,
    })
    expect(shouldRetryAuditMaintenanceFailure(failure)).toBe(true)
    expect(getAuditStartupDisposition({ failures: [failure] })).toEqual({
      shouldBlockStartup: false,
      shouldRecordSuccess: false,
    })
    expect(getStandaloneAuditExitCode({ failures: [failure] })).toBe(1)
  })

  it.each([
    'npm error code EAI_AGAIN',
    'npm error code ECONNRESET',
    'npm error network timeout',
    'npm error 429 Too Many Requests',
    'npm error 503 Service Unavailable',
    'npm error code ENOAUDIT',
  ])('treats a temporary registry failure as retryable: %s', (message) => {
    const failure = classifyAuditMaintenanceFailure(message, 'registry_command')

    expect(failure.kind).toBe('registry_unavailable')
    expect(failure.startupBlocking).toBe(false)
    expect(shouldRetryAuditMaintenanceFailure(failure)).toBe(true)
  })

  it('keeps local integrity failures and unknown command failures startup-blocking', () => {
    const localFailure = classifyAuditMaintenanceFailure(
      'Unable to read package-lock.json before npm audit remediation.',
      'local_integrity',
    )
    const unknownFailure = classifyAuditMaintenanceFailure(
      'npm audit terminated for an unknown reason',
      'registry_command',
    )

    expect(localFailure).toMatchObject({
      kind: 'local_integrity_failure',
      startupBlocking: true,
    })
    expect(unknownFailure).toMatchObject({
      kind: 'command_failure',
      startupBlocking: true,
    })
    expect(shouldRetryAuditMaintenanceFailure(localFailure)).toBe(false)
    expect(getAuditStartupDisposition({ failures: [localFailure] })).toEqual({
      shouldBlockStartup: true,
      shouldRecordSuccess: false,
    })
  })

  it('records successful maintenance only when no audit failure occurred', () => {
    expect(getAuditStartupDisposition({ failures: [] })).toEqual({
      shouldBlockStartup: false,
      shouldRecordSuccess: true,
    })
    expect(getStandaloneAuditExitCode({ failures: [] })).toBe(0)
  })
})

describe('aged dependency update selection', () => {
  const now = new Date('2026-05-12T12:00:00.000Z')

  it('chooses the newest newer stable version that has passed the release delay', () => {
    const selection = chooseAgedDependencyTarget({
      currentVersion: '1.0.0',
      latestVersion: '1.3.0',
      now,
      publishTimes: {
        '1.0.0': '2026-04-01T00:00:00.000Z',
        '1.1.0': '2026-05-01T00:00:00.000Z',
        '1.2.0': '2026-05-06T00:00:00.000Z',
        '1.3.0': '2026-05-10T00:00:00.000Z',
      },
    })

    expect(selection.targetVersion).toBe('1.1.0')
    expect(selection.nextEligibleAt).toBe('2026-05-13T00:00:00.000Z')
  })

  it('holds updates when every newer stable version is still inside the delay window', () => {
    const selection = chooseAgedDependencyTarget({
      currentVersion: '2.0.0',
      latestVersion: '2.2.0',
      now,
      publishTimes: {
        '2.0.0': '2026-04-01T00:00:00.000Z',
        '2.1.0': '2026-05-08T00:00:00.000Z',
        '2.2.0': '2026-05-11T00:00:00.000Z',
      },
    })

    expect(selection.targetVersion).toBeUndefined()
    expect(selection.reason).toBe('no-aged-version')
    expect(selection.nextEligibleAt).toBe('2026-05-15T00:00:00.000Z')
  })

  it('ignores prerelease versions when choosing an aged stable target', () => {
    const selection = chooseAgedDependencyTarget({
      currentVersion: '3.0.0',
      latestVersion: '3.2.0',
      now,
      publishTimes: {
        '3.1.0-beta.1': '2026-04-01T00:00:00.000Z',
        '3.1.0': '2026-05-01T00:00:00.000Z',
        '3.2.0': '2026-05-11T00:00:00.000Z',
      },
    })

    expect(selection.targetVersion).toBe('3.1.0')
  })

  it('allows OpenCode-scoped updates to bypass the release delay', () => {
    const selection = chooseAgedDependencyTarget({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      now,
      bypassAgeGate: true,
      publishTimes: {
        '1.1.0': '2026-05-12T11:00:00.000Z',
      },
    })

    expect(selection.targetVersion).toBe('1.1.0')
  })
})

describe('npm publish-time metadata parsing', () => {
  const publishTimes = {
    created: '2026-05-01T00:00:00.000Z',
    '1.2.3': '2026-05-02T00:00:00.000Z',
  }

  it('accepts the object shape returned by older npm releases', () => {
    expect(parseNpmViewPublishTimes(JSON.stringify(publishTimes))).toEqual(publishTimes)
  })

  it('accepts the one-element array shape returned by npm 12', () => {
    expect(parseNpmViewPublishTimes(JSON.stringify([publishTimes]))).toEqual(publishTimes)
  })

  it('rejects output without publish-time entries', () => {
    expect(parseNpmViewPublishTimes(JSON.stringify([]))).toBeNull()
    expect(parseNpmViewPublishTimes('not json')).toBeNull()
  })
})

describe('peer-safe dependency maintenance', () => {
  it('recognizes npm peer-resolution failures without treating unrelated failures as compatibility holds', () => {
    expect(isPeerResolutionFailure('npm error code ERESOLVE\nnpm error Could not resolve dependency:')).toBe(true)
    expect(isPeerResolutionFailure('npm error network timeout')).toBe(false)
  })

  it('extracts a concise peer constraint for held-release details', () => {
    expect(summarizePeerResolutionFailure(
      'npm error peer typescript@">=4.8.4" from ts-api-utils@2.5.0\n' +
      'npm error Could not resolve dependency:\nnpm error peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.63.0',
    )).toBe('peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.63.0')
  })

  it('preserves compatible semver range styles when staging a newer version', () => {
    expect(formatUpdatedDependencyRange('^6.0.3', '6.1.0')).toBe('^6.1.0')
    expect(formatUpdatedDependencyRange('~6.0.3', '6.0.4')).toBe('~6.0.4')
    expect(formatUpdatedDependencyRange('6.0.3', '6.0.4')).toBe('6.0.4')
  })
})

describe('audit lockfile age gating', () => {
  const now = new Date('2026-05-12T12:00:00.000Z')

  it('accepts npm audit exit 1 when the preview completed but vulnerabilities remain', () => {
    expect(isExpectedAuditFindingsExit({
      status: 1,
      stdout: 'up to date, audited 674 packages\n\n# npm audit report\n\n6 vulnerabilities (5 moderate, 1 high)',
      stderr: '',
    })).toBe(true)
    expect(isExpectedAuditFindingsExit({
      status: 1,
      stdout: '',
      stderr: 'npm error code ENOAUDIT\n# npm audit report\n6 vulnerabilities',
    })).toBe(false)
  })

  it('extracts proposed package version changes from npm audit lockfile previews', () => {
    const currentLock = JSON.stringify({
      packages: {
        '': { name: 'looptroop' },
        'node_modules/plain': { version: '1.0.0' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
      },
    })
    const proposedLock = JSON.stringify({
      packages: {
        '': { name: 'looptroop' },
        'node_modules/plain': { version: '1.1.0' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/wrapped/node_modules/nested': { version: '3.0.0' },
      },
    })

    const result = collectLockfilePackageUpdates(currentLock, proposedLock)

    expect(result.errors).toEqual([])
    expect(result.updates).toEqual([
      { name: 'nested', version: '3.0.0', currentVersion: undefined },
      { name: 'plain', version: '1.1.0', currentVersion: '1.0.0' },
    ])
  })

  it('marks proposed audit fix versions as held until their release delay passes', () => {
    const releaseAge = evaluatePackageVersionReleaseAge({
      version: '4.2.0',
      now,
      publishTimes: {
        '4.2.0': '2026-05-10T12:00:00.000Z',
      },
    })

    expect(releaseAge.eligible).toBe(false)
    expect(releaseAge.reason).toBe('too-new')
    expect(releaseAge.nextEligibleAt).toBe('2026-05-17T12:00:00.000Z')
  })

  it('allows proposed audit fix versions that are old enough', () => {
    const releaseAge = evaluatePackageVersionReleaseAge({
      version: '4.1.0',
      now,
      publishTimes: {
        '4.1.0': '2026-05-01T12:00:00.000Z',
      },
    })

    expect(releaseAge.eligible).toBe(true)
  })
})

describe('held dependency detail formatting', () => {
  it('describes the release-age policy used by dev startup messaging', () => {
    expect(formatDependencyReleasePolicySummaryLines()).toEqual([
      'Direct npm dependency updates and npm audit fixes wait until a release has been published for 7 days.',
      'Updates are previewed with npm peer resolution; incompatible releases and registry-tarball policy conflicts are held and never forced.',
      'OpenCode CLI and @opencode-ai/sdk updates are applied immediately.',
    ])
  })

  it('lists updated direct dependencies with package type and version movement', () => {
    const details = getDependencyUpdateReleaseDetails({
      updatedDependencies: ['alpha'],
      updatedDevDependencies: ['beta'],
      updatedDependencyDetails: [
        {
          name: 'alpha',
          current: '1.0.0',
          target: '1.1.0',
          bypassedAgeGate: false,
        },
      ],
      updatedDevDependencyDetails: [
        {
          name: 'beta',
          current: '2.0.0',
          target: '2.1.0',
          bypassedAgeGate: false,
        },
      ],
    })

    expect(details.map(formatDependencyUpdateReleaseDetail)).toEqual([
      'updated runtime dependency alpha 1.0.0 -> 1.1.0',
      'updated dev dependency beta 2.0.0 -> 2.1.0',
    ])
  })

  it('lists held direct dependencies with package type, versions, and eligibility time', () => {
    const details = getHeldDependencyReleaseDetails({
      heldDependencies: [
        {
          name: 'alpha',
          current: '1.0.0',
          latest: '1.1.0',
          nextEligibleAt: '2026-05-15T00:00:00.000Z',
          reason: 'no-aged-version',
        },
      ],
      heldDevDependencies: [
        {
          name: 'beta',
          current: '2.0.0',
          latest: '2.1.0',
          reason: 'metadata-unavailable',
        },
      ],
    })

    expect(details.map(formatHeldDependencyReleaseDetail)).toEqual([
      'held runtime dependency alpha 1.0.0 -> 1.1.0; because the 7-day release-safety period has not passed; ' +
      'eligible after 2026-05-15T00:00:00.000Z',
      'held dev dependency beta 2.0.0 -> 2.1.0; because npm could not return usable registry publish metadata, ' +
      'so the 7-day release age could not be verified',
    ])
  })

  it('explains peer-incompatible dependency holds without inventing an eligibility time', () => {
    const details = getHeldDependencyReleaseDetails({
      heldDependencies: [],
      heldDevDependencies: [{
        name: 'typescript',
        current: '6.0.3',
        latest: '7.0.2',
        reason: 'peer-incompatible',
        detail: 'peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.63.0',
      }],
    })

    expect(details.map(formatHeldDependencyReleaseDetail)).toEqual([
      'held dev dependency typescript 6.0.3 -> 7.0.2; because npm reported an incompatible peer dependency: ' +
      'peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.63.0',
    ])
  })

  it('explains registry-tarball policy holds and their daily retry', () => {
    const details = getHeldDependencyReleaseDetails({
      heldDependencies: [],
      heldDevDependencies: [{
        name: '@tailwindcss/vite',
        current: '4.3.2',
        latest: '4.3.3',
        reason: 'registry-tarball-policy',
        detail: 'npm rejected https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz as a remote URL',
      }],
    })

    expect(details.map(formatHeldDependencyReleaseDetail)).toEqual([
      'held dev dependency @tailwindcss/vite 4.3.2 -> 4.3.3; because npm rejected a registry-hosted tarball as a remote URL during lockfile preview; ' +
      'the update will be retried on the next daily check: npm rejected https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz as a remote URL',
    ])
  })

  it('only recognizes EALLOWREMOTE holds for the configured registry host', () => {
    const message = [
      'npm error code EALLOWREMOTE',
      'npm error Fetching packages of type "remote" have been disabled',
      'npm error Refusing to fetch "https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz"',
    ].join('\n')

    expect(getRegistryHostedRemotePolicyFailureUrl(message, 'https://registry.npmjs.org/')).toBe(
      'https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz',
    )
    expect(getRegistryHostedRemotePolicyFailureUrl(message, 'https://registry.example.test/')).toBeNull()
  })

  it('explains metadata and version-comparison holds without relying on the policy summary', () => {
    const details = getHeldDependencyReleaseDetails({
      heldDependencies: [{
        name: 'metadata-package',
        current: '1.0.0',
        latest: '1.1.0',
        reason: 'metadata-unavailable',
      }],
      heldDevDependencies: [{
        name: 'tagged-package',
        current: 'workspace:latest',
        latest: '2.0.0',
        reason: 'non-semver-current',
      }],
    })

    expect(details.map(formatHeldDependencyReleaseDetail)).toEqual([
      'held runtime dependency metadata-package 1.0.0 -> 1.1.0; ' +
      'because npm could not return usable registry publish metadata, so the 7-day release age could not be verified',
      'held dev dependency tagged-package workspace:latest -> 2.0.0; ' +
      'because the current version is not a stable semantic version',
    ])
  })

  it('lists held audit packages with proposed versions and eligibility time', () => {
    const details = getHeldAuditPackageReleaseDetails([
      {
        name: 'beta',
        version: '2.1.0',
        currentVersion: '2.0.0',
        nextEligibleAt: '2026-05-16T00:00:00.000Z',
        reason: 'too-new',
      },
    ])

    expect(details.map(formatHeldAuditPackageUpdate)).toEqual([
      'held audit fix beta 2.0.0 -> 2.1.0; because the 7-day release-safety period has not passed; ' +
      'eligible after 2026-05-16T00:00:00.000Z',
    ])
  })
})
