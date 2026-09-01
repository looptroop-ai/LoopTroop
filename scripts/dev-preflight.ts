import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBackendPort, getFrontendPort } from '../shared/appConfig'
import { readDaemonState } from '../server/lib/daemonPaths'
import { matchProcess } from '../server/lib/processIdentity'
import { isProcessAlive } from '../server/cli/processControl'
import { getErrorMessage } from '../shared/typeGuards'
import { resolveDevHostMode } from './dev-host-mode'
import {
  decideDailyMaintenanceTask,
  ensureInstallIfNeeded,
  getAuditStartupDisposition,
  getMissingBins,
  readDailyMaintenanceState,
  recordDailyMaintenanceSuccess,
  remediateAudit,
  syncDirectDependencies,
  upgradeOpenCodeCli,
  writeDailyMaintenanceState,
  writeDevPreflightReport,
} from './dev-maintenance'
import {
  buildProcessGraph,
  collectProcessTree,
  decideDaemonProtection,
  formatProcessSummary,
  isLoopTroopDevProcess,
  findOwningRootProcess,
  parseProcessTable,
  resolveProcessTreesToTerminate,
  type ProcessInfo,
} from './dev-preflight-utils'
import {
  describePortOccupants,
  formatPortOccupantSummary,
  inspectPortOccupants,
} from './port-occupants'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const packageJsonPath = resolve(repoRoot, 'package.json')
const packageLockPath = resolve(repoRoot, 'package-lock.json')
// Preflight repairs the dev environment: it runs `npm ci` when the install is
// stale, and clears stale LoopTroop dev process trees off the configured ports.
// Every action is announced with its reason before it runs. A daemon started by
// `looptroop start` is protected and never treated as a stale tree.
// Dependency sync, audit remediation and the OpenCode upgrade rewrite
// package.json, the lockfile, or a globally installed CLI, so they stay opt-in
// via `npm run deps:sync`, `npm run audit:remediate` and
// `npm run opencode:upgrade`.
const maintenanceOptIn = process.env.LOOPTROOP_DEV_MAINTENANCE === '1'
const shouldSkipDependencyMaintenance = !maintenanceOptIn || process.env.LOOPTROOP_DEV_SKIP_DEPS === '1'
const shouldSkipOpenCodeUpgrade = !maintenanceOptIn || process.env.LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE === '1'
const shouldForceDailyMaintenance = maintenanceOptIn && process.env.LOOPTROOP_DEV_FORCE_MAINTENANCE === '1'
const devHostMode = (() => {
  try {
    return resolveDevHostMode()
  } catch (error) {
    const message = getErrorMessage(error)
    console.error(`[dev-preflight] ${message}`)
    process.exit(1)
  }
})()
const portAvailabilityHost = devHostMode.enabled ? devHostMode.bindHost : '127.0.0.1'

const configuredPorts = [
  { label: 'frontend', port: getFrontendPort() },
  { label: 'backend', port: getBackendPort() },
]

const preflightStartedAt = Date.now()

function logProgress(message: string) {
  console.log(`[dev-preflight] ${message}`)
}

function formatElapsedTime(startedAt: number) {
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`
  }

  return `${(elapsedMs / 1000).toFixed(1)}s`
}

function listProcesses() {
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    return parseProcessTable(output)
  } catch (error) {
    const message = getErrorMessage(error)
    console.warn(`[dev-preflight] Process table inspection is unavailable on this platform: ${message}`)
    return []
  }
}

function collectProtectedPids(currentPid: number, graph: ReturnType<typeof buildProcessGraph>) {
  const protectedPids = new Set<number>()
  let current = graph.byPid.get(currentPid)

  while (current) {
    protectedPids.add(current.pid)
    current = graph.byPid.get(current.ppid)
  }

  // A `looptroop start` daemon is a real user session, not a stale dev tree.
  // Its process tree looks identical to one, so protect it explicitly — but only
  // once the pid in the record has been shown to still be that daemon.
  const protection = decideDaemonProtection(readDaemonState(), {
    isProcessAlive,
    matchProcess: (pid, token) => matchProcess(pid, token),
  })

  for (const warning of protection.warnings) {
    console.warn(`[dev-preflight] ${warning}`)
  }

  for (const pid of protection.pids) {
    for (const entry of collectProcessTree(pid, graph)) {
      protectedPids.add(entry.pid)
    }
    protectedPids.add(pid)
  }

  return protectedPids
}

function killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function sleep(ms: number) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function ensurePortFree(port: number, host = '127.0.0.1') {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = net.createServer()
    server.once('error', (error) => {
      server.close()
      rejectPromise(error)
    })
    server.listen(port, host, () => {
      server.close((closeError) => {
        if (closeError) {
          rejectPromise(closeError)
          return
        }
        resolvePromise()
      })
    })
  })
}

async function terminateProcessTree(root: ProcessInfo, graph = buildProcessGraph(listProcesses())) {
  const processTree = collectProcessTree(root.pid, graph)
  console.log(
    `[dev-preflight] Stopping stale LoopTroop dev tree rooted at ${formatProcessSummary(root)}` +
    ` (${processTree.length} ${processTree.length === 1 ? 'process' : 'processes'}).`,
  )

  for (const entry of processTree) {
    killProcess(entry.pid)
  }

  await sleep(300)

  const survivors = processTree.filter((entry) => isProcessAlive(entry.pid))
  if (survivors.length > 0) {
    console.warn(
      `[dev-preflight] Escalating to SIGKILL for ${survivors.length} stubborn ` +
      `${survivors.length === 1 ? 'process' : 'processes'} in the stale dev tree.`,
    )
    for (const entry of survivors) {
      killProcess(entry.pid, 'SIGKILL')
    }
    await sleep(300)
  }
}

async function reclaimOccupiedPorts(ports: number[]) {
  const processes = listProcesses()
  const graph = buildProcessGraph(processes)
  const protectedPids = collectProtectedPids(process.pid, graph)

  const initialRoots = new Map<number, ProcessInfo>()
  const unresolvedOccupants: Array<{ port: number; summary: string }> = []

  for (const port of ports) {
    const inspection = inspectPortOccupants(port)
    const occupantPids = inspection.occupants
      .map((occupant) => occupant.pid)
      .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    const resolution = resolveProcessTreesToTerminate(processes, occupantPids, repoRoot)
    for (const root of resolution.roots) {
      if (protectedPids.has(root.pid)) continue
      initialRoots.set(root.pid, root)
    }
    for (const occupant of resolution.unrelatedOccupants) {
      const knownOccupant = inspection.occupants.find((entry) => entry.pid === occupant.pid)
      unresolvedOccupants.push({
        port,
        summary: formatPortOccupantSummary(
          knownOccupant ?? { pid: occupant.pid, command: occupant.args },
        ) ?? formatProcessSummary(occupant),
      })
    }
  }

  if (unresolvedOccupants.length > 0) {
    for (const occupant of unresolvedOccupants) {
      console.error(
        `[dev-preflight] Refusing to terminate unrelated occupant on port ${occupant.port}: ${occupant.summary}`,
      )
    }
    return false
  }

  for (const root of initialRoots.values()) {
    await terminateProcessTree(root, graph)
  }

  await sleep(500)
  return true
}

function ensureDistinctConfiguredPorts() {
  const labelsByPort = new Map<number, string[]>()

  for (const { label, port } of configuredPorts) {
    const labels = labelsByPort.get(port) ?? []
    labels.push(label)
    labelsByPort.set(port, labels)
  }

  let hasConflict = false
  for (const [port, labels] of labelsByPort) {
    if (labels.length < 2) continue
    hasConflict = true
    console.error(
      `[dev-preflight] Port configuration conflict: ${labels.join(', ')} all use ${port}. ` +
      'Set LOOPTROOP_FRONTEND_PORT and LOOPTROOP_BACKEND_PORT to distinct values.',
    )
  }

  if (hasConflict) {
    process.exit(1)
  }
}

logProgress('Validating configured dev ports.')
ensureDistinctConfiguredPorts()
const maintenanceState = readDailyMaintenanceState()

logProgress('Checking local dependency installation.')
const installReport = ensureInstallIfNeeded()
for (const error of installReport.errors) {
  console.error(`[dev-preflight] ${error}`)
}
if (installReport.errors.length > 0) {
  process.exit(1)
}

logProgress('Checking direct dependency maintenance schedule.')
const dependencySyncDecision = decideDailyMaintenanceTask({
  taskName: 'dependencySync',
  state: maintenanceState,
  force: shouldForceDailyMaintenance,
  invalidatedByPaths: [packageJsonPath],
})

if (shouldSkipDependencyMaintenance) {
  logProgress(maintenanceOptIn
    ? 'Skipping direct dependency sync because LOOPTROOP_DEV_SKIP_DEPS=1.'
    : 'Dependency sync is opt-in; run `npm run deps:sync` to update dependencies.')
} else if (dependencySyncDecision.shouldRun) {
  logProgress('Checking direct npm dependencies for eligible updates; this daily network check may take a moment.')
} else {
  logProgress('Direct dependency sync already completed today; deferring.')
}

const dependencySyncReport = shouldSkipDependencyMaintenance
  ? syncDirectDependencies({
    skip: true,
  })
  : dependencySyncDecision.shouldRun
    ? syncDirectDependencies({
      skip: false,
    })
    : {
      skipped: false,
      deferred: true,
      checked: false,
      alreadyCurrent: false,
      isForced: false,
      errors: [],
      updatedDependencies: [],
      updatedDevDependencies: [],
      updatedDependencyDetails: [],
      updatedDevDependencyDetails: [],
      heldDependencies: [],
      heldDevDependencies: [],
      lastCompletedAt: dependencySyncDecision.lastCompletedAt,
      nextEligibleAt: dependencySyncDecision.nextEligibleAt,
    }

for (const error of dependencySyncReport.errors) {
  console.error(`[dev-preflight] ${error}`)
}
if (dependencySyncReport.errors.length > 0) {
  process.exit(1)
}
if (!shouldSkipDependencyMaintenance && dependencySyncDecision.shouldRun && dependencySyncReport.checked && dependencySyncReport.errors.length === 0) {
  recordDailyMaintenanceSuccess(maintenanceState, 'dependencySync')
}

logProgress('Checking audit maintenance schedule.')
const auditDecision = decideDailyMaintenanceTask({
  taskName: 'audit',
  state: maintenanceState,
  force: shouldForceDailyMaintenance,
  invalidatedByPaths: [packageJsonPath, packageLockPath],
})

if (shouldSkipDependencyMaintenance) {
  logProgress(maintenanceOptIn
    ? 'Skipping npm audit remediation because LOOPTROOP_DEV_SKIP_DEPS=1.'
    : 'Audit remediation is opt-in; run `npm run audit:remediate` to apply fixes.')
} else if (auditDecision.shouldRun) {
  logProgress('Previewing npm audit remediation; this daily lockfile check may take a moment.')
} else {
  logProgress('npm audit remediation already completed today; deferring.')
}

const auditReport = shouldSkipDependencyMaintenance
  ? remediateAudit({
    skip: true,
  })
  : auditDecision.shouldRun
    ? remediateAudit({
      skip: false,
    })
    : {
      skipped: false,
      deferred: true,
      didFixRun: false,
      fixChanged: false,
      fixHeld: false,
      appliedPackageUpdates: [],
      heldPackageUpdates: [],
      unresolved: [],
      totals: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
      errors: [],
      failures: [],
      lastCompletedAt: auditDecision.lastCompletedAt,
      nextEligibleAt: auditDecision.nextEligibleAt,
    }

const auditDisposition = getAuditStartupDisposition(auditReport)
for (const failure of auditReport.failures) {
  const prefix = failure.startupBlocking
    ? '[dev-preflight]'
    : '[dev-preflight] npm audit maintenance deferred; startup will continue:'
  const log = failure.startupBlocking ? console.error : console.warn
  log(`${prefix} ${failure.message}`)
}
if (auditDisposition.shouldBlockStartup) {
  process.exit(1)
}
if (!shouldSkipDependencyMaintenance && auditDecision.shouldRun && auditDisposition.shouldRecordSuccess) {
  recordDailyMaintenanceSuccess(maintenanceState, 'audit')
}

logProgress('Checking OpenCode maintenance schedule.')
const opencodeDecision = decideDailyMaintenanceTask({
  taskName: 'opencode',
  state: maintenanceState,
  force: shouldForceDailyMaintenance,
})

if (shouldSkipOpenCodeUpgrade) {
  logProgress(maintenanceOptIn
    ? 'Skipping OpenCode CLI upgrade because LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1.'
    : 'OpenCode CLI upgrade is opt-in; run `npm run opencode:upgrade` to update it.')
} else if (opencodeDecision.shouldRun) {
  logProgress('Checking OpenCode CLI for updates; this daily check may take a moment.')
} else {
  logProgress('OpenCode CLI upgrade already completed today; deferring.')
}

const opencodeReport = shouldSkipOpenCodeUpgrade
  ? upgradeOpenCodeCli({
    skip: true,
    logPrefix: '',
  })
  : opencodeDecision.shouldRun
    ? upgradeOpenCodeCli({
      skip: false,
      logPrefix: '',
    })
    : {
      skipped: false,
      deferred: true,
      available: true,
      checked: false,
      upgraded: false,
      alreadyCurrent: false,
      errors: [],
      lastCompletedAt: opencodeDecision.lastCompletedAt,
      nextEligibleAt: opencodeDecision.nextEligibleAt,
    }

for (const error of opencodeReport.errors) {
  console.error(`[dev-preflight] ${error}`)
}
if (opencodeReport.errors.length > 0) {
  process.exit(1)
}
if (!shouldSkipOpenCodeUpgrade && opencodeDecision.shouldRun && opencodeReport.errors.length === 0 && opencodeReport.available) {
  recordDailyMaintenanceSuccess(maintenanceState, 'opencode')
}

writeDailyMaintenanceState(maintenanceState)

logProgress('Verifying required local dev binaries.')
const missingBinsAfterMaintenance = getMissingBins()
if (missingBinsAfterMaintenance.length > 0) {
  console.error(
    '[dev-preflight] Required dev tools are missing after dependency install checks: ' +
    missingBinsAfterMaintenance.join(', '),
  )
  process.exit(1)
}

logProgress('Checking for stale LoopTroop dev processes.')
const processes = listProcesses()
const graph = buildProcessGraph(processes)
const protectedPids = collectProtectedPids(process.pid, graph)
const staleRoots = new Map<number, ProcessInfo>()
for (const processEntry of processes) {
  if (processEntry.pid === process.pid) continue
  if (!isLoopTroopDevProcess(processEntry.args, repoRoot)) continue
  const root = findOwningRootProcess(processEntry, graph, repoRoot)
  if (root && !protectedPids.has(root.pid)) {
    staleRoots.set(root.pid, root)
  }
}

for (const root of staleRoots.values()) {
  await terminateProcessTree(root, graph)
}

if (staleRoots.size > 0) {
  await sleep(500)
}

logProgress(
  'Checking service port availability for ' +
  configuredPorts.map(({ label, port }) => `${label}:${port}`).join(', ') +
  '.',
)
const reclaimed = await reclaimOccupiedPorts(configuredPorts.map(({ port }) => port))
if (!reclaimed) {
  process.exit(1)
}

for (const { label, port } of configuredPorts) {
  try {
    await ensurePortFree(port, portAvailabilityHost)
  } catch (error) {
    const inspection = inspectPortOccupants(port)
    const occupantPids = inspection.occupants
      .map((occupant) => occupant.pid)
      .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    const remainingProcesses = listProcesses()
    const resolution = resolveProcessTreesToTerminate(remainingProcesses, occupantPids, repoRoot)
    if (resolution.roots.length > 0) {
      const graph = buildProcessGraph(remainingProcesses)
      const protectedPids = collectProtectedPids(process.pid, graph)
      for (const root of resolution.roots) {
        if (protectedPids.has(root.pid)) continue
        await terminateProcessTree(root, graph)
      }
      await sleep(500)
    }

    try {
      await ensurePortFree(port, portAvailabilityHost)
    } catch (retryError) {
      const updatedInspection = inspectPortOccupants(port)
      const message = getErrorMessage(retryError)
      console.error(`[dev-preflight] Cannot start LoopTroop ${label} service on port ${port}: ${message}`)
      console.error(`[dev-preflight] ${describePortOccupants(port, updatedInspection)}`)
      if (error instanceof Error && error.message) {
        console.error(`[dev-preflight] Initial check failed with: ${error.message}`)
      }
      process.exit(1)
    }
  }
}

writeDevPreflightReport({
  generatedAt: new Date().toISOString(),
  install: installReport,
  dependencySync: dependencySyncReport,
  audit: auditReport,
  opencode: opencodeReport,
})

logProgress(`Startup preflight complete in ${formatElapsedTime(preflightStartedAt)}.`)
