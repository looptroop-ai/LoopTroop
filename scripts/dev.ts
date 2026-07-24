import { randomBytes } from 'node:crypto'
import concurrently from 'concurrently'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { DEFAULT_OPENCODE_BASE_URL, getBackendPort, getDocsOrigin, getDocsPort, getFrontendPort } from '../shared/appConfig'
import {
  formatAuditPackageUpdate,
  formatDependencyReleasePolicySummaryLines,
  formatDependencyUpdateReleaseDetail,
  formatHeldAuditPackageUpdate,
  formatHeldDependencyReleaseDetail,
  getAuditPackageUpdateDetails,
  getDependencyUpdateReleaseDetails,
  getHeldAuditPackageReleaseDetails,
  getHeldDependencyReleaseDetails,
  readDevPreflightReport,
  type DependencySyncReport,
} from './dev-maintenance'
import { getDevLanUrls, LOOPTROOP_DEV_HOST, resolveDevHostMode } from './dev-host-mode'
import { resolveOpenCodeBaseUrl } from './opencode-dev-base-url'
import { LOOPTROOP_OPENCODE_LOGS, resolveOpenCodeLogMode } from './opencode-log-mode'
import { getWslLanAccessPlan } from './wsl-lan-access'
import { getErrorMessage } from '../shared/typeGuards'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const requestedBaseUrl = process.env.LOOPTROOP_OPENCODE_BASE_URL?.trim() || DEFAULT_OPENCODE_BASE_URL
const hasExplicitBaseUrl = Boolean(process.env.LOOPTROOP_OPENCODE_BASE_URL?.trim())
const childEnv = { ...process.env }
const preflightReport = readDevPreflightReport()
const frontendPort = getFrontendPort()
const backendPort = getBackendPort()
const docsPort = getDocsPort()
let shutdownSignal: NodeJS.Signals | null = null
let shutdownStartedAtMs: number | null = null

delete childEnv.NO_COLOR
delete childEnv.FORCE_COLOR

type DevService = {
  name: string
  prefixColor: string
  command: string
  displayCommand: string
  description: string
}

const opencodeLogMode = (() => {
  try {
    return resolveOpenCodeLogMode()
  } catch (error) {
    console.error(`[dev] ${getErrorMessage(error)}`)
    process.exit(1)
  }
})()

const devHostMode = (() => {
  try {
    return resolveDevHostMode()
  } catch (error) {
    console.error(`[dev] ${getErrorMessage(error)}`)
    process.exit(1)
  }
})()

const wslLanAccess = getWslLanAccessPlan({ hostMode: devHostMode, frontendPort, docsPort })
const directFrontendLanUrls = getDevLanUrls({ hostMode: devHostMode, port: frontendPort })
const directDocsLanUrls = getDevLanUrls({ hostMode: devHostMode, port: docsPort })
const isWslAccessRelevant = devHostMode.enabled && wslLanAccess.reason !== 'Runtime is not WSL.'
const frontendLanUrls = isWslAccessRelevant
  ? []
  : directFrontendLanUrls
const docsLanUrls = isWslAccessRelevant
  ? []
  : directDocsLanUrls
const configuredDocsOrigin = process.env.LOOPTROOP_DOCS_ORIGIN?.trim()
const effectiveDocsOrigin = configuredDocsOrigin || docsLanUrls[0] || getDocsOrigin()

if (opencodeLogMode.mode === 'all') {
  childEnv[LOOPTROOP_OPENCODE_LOGS] = 'all'
}

if (devHostMode.enabled) {
  childEnv[LOOPTROOP_DEV_HOST] = devHostMode.bindHost
}

if (devHostMode.enabled && !configuredDocsOrigin && docsLanUrls[0]) {
  childEnv.LOOPTROOP_DOCS_ORIGIN = docsLanUrls[0]
}

const { baseUrl, note, status } = await resolveOpenCodeBaseUrl({
  requestedBaseUrl,
  hasExplicitBaseUrl,
  mockMode: process.env.LOOPTROOP_OPENCODE_MODE === 'mock',
})

if (note) {
  console.log(`[dev] ${note}`)
}

if (status === 'ready-to-start' && !childEnv.OPENCODE_SERVER_PASSWORD?.trim()) {
  childEnv.OPENCODE_SERVER_USERNAME = childEnv.OPENCODE_SERVER_USERNAME?.trim() || 'opencode'
  childEnv.OPENCODE_SERVER_PASSWORD = randomBytes(18).toString('base64url')
  console.log('[dev] Securing the local OpenCode dev server with ephemeral basic auth.')
}

if (!childEnv.LOOPTROOP_API_TOKEN?.trim()) {
  childEnv.LOOPTROOP_API_TOKEN = randomBytes(24).toString('base64url')
  console.log('[dev] Securing the local LoopTroop API with an ephemeral token.')
}

function printSummaryLine(label: string, value: string) {
  console.log(`[dev] ${label.padEnd(13)} ${value}`)
}

function printSummaryBlock(label: string, values: string[]) {
  for (const [index, value] of values.entries()) {
    printSummaryLine(index === 0 ? label : '', value)
  }
}

function printDivider(title: string) {
  const bar = '='.repeat(18)
  console.log(`[dev] ${bar} ${title} ${bar}`)
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0s'
  }

  if (seconds > 0 && seconds < 1) {
    return '<1s'
  }

  const totalSeconds = Math.round(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  parts.push(`${remainingSeconds}s`)
  return parts.join(' ')
}

function formatMaintenanceTimestamp(timestamp?: string) {
  if (!timestamp) {
    return 'unknown time'
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return timestamp
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function getHeldDependencyCount(report: DependencySyncReport) {
  return (report.heldDependencies?.length ?? 0) + (report.heldDevDependencies?.length ?? 0)
}

function getUpdatedRuntimeDependencyCount(report: DependencySyncReport) {
  return report.updatedDependencyDetails?.length ?? report.updatedDependencies?.length ?? 0
}

function getUpdatedDevDependencyCount(report: DependencySyncReport) {
  return report.updatedDevDependencyDetails?.length ?? report.updatedDevDependencies?.length ?? 0
}

function printDependencyUpdateDetails(report: DependencySyncReport) {
  for (const update of getDependencyUpdateReleaseDetails(report)) {
    console.log(`[dev]   - ${formatDependencyUpdateReleaseDetail(update)}`)
  }
}

function printHeldDependencyDetails(report: DependencySyncReport) {
  for (const held of getHeldDependencyReleaseDetails(report)) {
    console.log(`[dev]   - ${formatHeldDependencyReleaseDetail(held)}`)
  }
}

function printAuditPackageUpdateDetails(report: NonNullable<ReturnType<typeof readDevPreflightReport>>['audit']) {
  for (const update of getAuditPackageUpdateDetails(report.appliedPackageUpdates ?? [])) {
    console.log(`[dev]   - ${formatAuditPackageUpdate(update)}`)
  }
}

function printHeldAuditDetails(report: NonNullable<ReturnType<typeof readDevPreflightReport>>['audit']) {
  for (const held of getHeldAuditPackageReleaseDetails(report.heldPackageUpdates)) {
    console.log(`[dev]   - ${formatHeldAuditPackageUpdate(held)}`)
  }
}

function printAuditIssueDetails(report: NonNullable<ReturnType<typeof readDevPreflightReport>>['audit']) {
  const visibleIssues = report.unresolved.slice(0, 5)
  for (const issue of visibleIssues) {
    console.log(`[dev]   - ${issue.name} (${issue.severity})${issue.note ? `: ${issue.note}` : ''}`)
  }
  if (report.unresolved.length > visibleIssues.length) {
    console.log(`[dev]   - ${report.unresolved.length - visibleIssues.length} more audit finding(s); run npm run audit:remediate for full details.`)
  }
}

function formatOpenCodeLogSummary(status: string) {
  const consoleNote = opencodeLogMode.mode === 'all'
    ? 'also printing to console'
    : 'console-quiet; use --opencode-logs=all to print to console too'

  if (status === 'ready-to-start') {
    return `Full OpenCode DEBUG logs written to log directory (${consoleNote})`
  }

  return `Full OpenCode DEBUG logs enabled; reusing or skipping managed server (${consoleNote})`
}

function formatLanSharingSummary() {
  if (!devHostMode.enabled) {
    return 'Disabled. Use npm run dev --lan to share the app on your local network.'
  }

  return `Enabled on ${devHostMode.bindHost}. Use only on trusted local networks.`
}

async function printLanSharingDetails() {
  if (!devHostMode.enabled) return

  printSummaryLine('LAN warning', 'Frontend/docs are visible to devices on your local network; backend/OpenCode stay loopback-only.')
  if (wslLanAccess.enabled) {
    printSummaryLine('WSL note', `WSL uses a private ${wslLanAccess.wslTargetAddress ?? '172.x'} network behind Windows, so other LAN devices cannot reach it directly.`)
    printSummaryLine('WSL command', 'Run this one-liner in Windows PowerShell as Administrator; it listens on the Windows LAN IP and forwards into WSL:')
    printSummaryBlock('', wslLanAccess.setupCommands)
    printSummaryBlock('After setup', wslLanAccess.frontendUrls)
    if (wslLanAccess.docsUrls.length > 0) {
      printSummaryBlock('Docs setup', wslLanAccess.docsUrls.map((url) => `${url}/docs/`))
    }
    const primaryWslFrontendUrl = wslLanAccess.frontendUrls[0]
    if (primaryWslFrontendUrl) {
      await printMobileQr(primaryWslFrontendUrl)
    }
    printSummaryLine('WSL tip', 'The PowerShell command checks the Windows profile and self-tests the forwarded URLs; router isolation can only be inferred.')
    printSummaryLine('WSL cleanup', 'Remove it later with this Admin PowerShell one-liner:')
    printSummaryBlock('', wslLanAccess.cleanupCommands)
    return
  } else if (isWslAccessRelevant) {
    printSummaryLine('WSL mode', `${wslLanAccess.reason ?? 'Unavailable.'} WSL 172.x URLs are usually not reachable from other devices.`)
  }

  if (frontendLanUrls.length === 0) {
    printSummaryLine('LAN URLs', `No non-loopback IPv4 address detected; try ${LOOPTROOP_DEV_HOST}=<your LAN IP> npm run dev.`)
    return
  }

  const primaryFrontendLanUrl = frontendLanUrls[0]
  if (!primaryFrontendLanUrl) return

  printSummaryBlock('LAN URLs', frontendLanUrls)
  if (docsLanUrls.length > 0) {
    printSummaryBlock('Docs LAN', docsLanUrls.map((url) => `${url}/docs/`))
  }

  await printMobileQr(primaryFrontendLanUrl)
}

async function printMobileQr(url: string) {
  try {
    const qrCode = await QRCode.toString(url, {
      type: 'terminal',
      small: true,
      margin: 1,
    })

    console.log(`[dev] Mobile QR     Scan to open ${url}`)
    console.log(qrCode.trimEnd())
  } catch (error) {
    console.warn(`[dev] Mobile QR     Failed to render QR code: ${getErrorMessage(error)}`)
  }
}

const services: DevService[] = [
  {
    name: 'OPEN',
    prefixColor: 'bgYellow.black',
    command: 'npm:dev:opencode',
    displayCommand: 'tsx scripts/dev-opencode.ts',
    description: 'Ensure the local OpenCode server is reachable, then start it if needed.',
  },
  {
    name: 'WEB',
    prefixColor: 'bgBlue.black',
    command: 'npm:dev:frontend',
    displayCommand: 'vite',
    description: 'Start the frontend dev server for the LoopTroop dashboard.',
  },
  {
    name: 'API',
    prefixColor: 'bgGreen.black',
    command: 'npm:dev:backend',
    displayCommand: 'tsx scripts/dev-backend.ts',
    description: 'Watch the backend and restart it when server files change.',
  },
  {
    name: 'DOCS',
    prefixColor: 'bgMagenta.black',
    command: 'npm:docs:dev',
    displayCommand: 'tsx scripts/dev-docs.ts',
    description: 'Serve the VitePress documentation site alongside the app.',
  },
]

printDivider('Startup Summary')
printSummaryLine('LoopTroop App', `http://localhost:${frontendPort}`)
printSummaryLine('Backend', `http://localhost:${backendPort}`)
printSummaryLine('Documentation', `${effectiveDocsOrigin}/docs/`)
printSummaryLine('OpenCode', baseUrl)
printSummaryLine('LAN sharing', formatLanSharingSummary())
await printLanSharingDetails()
printSummaryLine('OpenCode logs', formatOpenCodeLogSummary(status))
printSummaryBlock('Package gate', formatDependencyReleasePolicySummaryLines())

if (preflightReport) {
  if (preflightReport.opencode.skipped) {
    printSummaryLine('OpenCode CLI', 'Skipped automatic OpenCode upgrade via LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1')
  } else if (preflightReport.opencode.deferred) {
    printSummaryLine(
      'OpenCode CLI',
      `Deferred daily upgrade check; last completed today at ${formatMaintenanceTimestamp(preflightReport.opencode.lastCompletedAt)}`,
    )
  } else if (!preflightReport.opencode.available) {
    printSummaryLine('OpenCode CLI', 'Local opencode binary not found; skipped automatic CLI upgrade')
  } else if (preflightReport.opencode.upgraded) {
    printSummaryLine(
      'OpenCode CLI',
      `Upgraded ${preflightReport.opencode.versionBefore ?? 'unknown'} -> ${preflightReport.opencode.versionAfter ?? 'unknown'}` +
      (preflightReport.opencode.method ? ` via ${preflightReport.opencode.method}` : ''),
    )
  } else {
    printSummaryLine(
      'OpenCode CLI',
      `Already current at ${preflightReport.opencode.versionAfter ?? preflightReport.opencode.versionBefore ?? 'unknown'}` +
      (preflightReport.opencode.method ? ` via ${preflightReport.opencode.method}` : ''),
    )
  }

  if (preflightReport.dependencySync.skipped) {
    printSummaryLine('Dependencies', 'Skipped automatic dependency sync via LOOPTROOP_DEV_SKIP_DEPS=1')
  } else if (preflightReport.dependencySync.deferred) {
    printSummaryLine(
      'Dependencies',
      `Deferred daily release-age check; last completed today at ${formatMaintenanceTimestamp(preflightReport.dependencySync.lastCompletedAt)}`,
    )
  } else if (preflightReport.dependencySync.alreadyCurrent) {
    printSummaryLine('Dependencies', 'All direct dependencies already matched npm latest stable')
  } else if (
    getUpdatedRuntimeDependencyCount(preflightReport.dependencySync) === 0 &&
    getUpdatedDevDependencyCount(preflightReport.dependencySync) === 0 &&
    getHeldDependencyCount(preflightReport.dependencySync) > 0
  ) {
    const heldCount = getHeldDependencyCount(preflightReport.dependencySync)
    printSummaryLine(
      'Dependencies',
      `Held ${heldCount} newer ${heldCount === 1 ? 'release' : 'releases'} behind release-age or compatibility gates.`,
    )
  } else {
    const heldCount = getHeldDependencyCount(preflightReport.dependencySync)
    const runtimeCount = getUpdatedRuntimeDependencyCount(preflightReport.dependencySync)
    const devCount = getUpdatedDevDependencyCount(preflightReport.dependencySync)
    printSummaryLine(
      'Dependencies',
      `Updated ${runtimeCount} runtime and ` +
      `${devCount} dev packages to eligible releases` +
      (heldCount > 0 ? `; held ${heldCount}` : '') +
      '.',
    )
  }
  if (
    !preflightReport.dependencySync.skipped &&
    !preflightReport.dependencySync.deferred &&
    (
      getDependencyUpdateReleaseDetails(preflightReport.dependencySync).length > 0 ||
      getHeldDependencyCount(preflightReport.dependencySync) > 0
    )
  ) {
    printDependencyUpdateDetails(preflightReport.dependencySync)
    printHeldDependencyDetails(preflightReport.dependencySync)
  }

  if (preflightReport.audit.skipped) {
    printSummaryLine('Audit', 'Skipped automatic audit remediation via LOOPTROOP_DEV_SKIP_DEPS=1')
  } else if (preflightReport.audit.deferred) {
    printSummaryLine(
      'Audit',
      `Deferred daily remediation; last completed today at ${formatMaintenanceTimestamp(preflightReport.audit.lastCompletedAt)}`,
    )
  } else if (preflightReport.audit.fixHeld) {
    const heldCount = preflightReport.audit.heldPackageUpdates.length
    printSummaryLine(
      'Audit',
      preflightReport.audit.compatibilityHold
        ? `Held remediation because npm rejected an incompatible peer dependency graph: ${preflightReport.audit.compatibilityHold}.`
        : `Held remediation; ${heldCount} proposed ` +
          `${heldCount === 1 ? 'release is' : 'releases are'} inside the 7-day delay.`,
    )
  } else if (preflightReport.audit.unresolved.length === 0) {
    if (preflightReport.audit.fixChanged) {
      printSummaryLine('Audit', 'npm audit fix updated the dependency graph; no remaining npm audit findings')
    } else {
      printSummaryLine('Audit', 'No remaining npm audit findings after remediation')
    }
  } else {
    printSummaryLine(
      'Audit',
      `${preflightReport.audit.totals.total} remaining finding(s): ` +
      `high=${preflightReport.audit.totals.high}, moderate=${preflightReport.audit.totals.moderate}.`,
    )
    printAuditIssueDetails(preflightReport.audit)
  }
  if (!preflightReport.audit.skipped && !preflightReport.audit.deferred) {
    if (preflightReport.audit.fixHeld) {
      printHeldAuditDetails(preflightReport.audit)
    } else if (preflightReport.audit.fixChanged) {
      printAuditPackageUpdateDetails(preflightReport.audit)
    }
  }
}

printDivider('Live Services')
console.log('[dev] Launching frontend, backend, docs, and OpenCode watchers...')

const { commands, result } = concurrently(
  services.map((service) => ({
    command: service.command,
    name: service.name,
    prefixColor: service.prefixColor,
    env: {
      ...childEnv,
      LOOPTROOP_OPENCODE_BASE_URL: baseUrl,
    },
  })),
  {
    cwd: repoRoot,
    prefix: '[{time} {name}]',
    timestampFormat: 'HH:mm:ss',
    padPrefix: true,
    prefixColors: services.map((service) => service.prefixColor),
    timings: false,
    successCondition: 'all',
    killOthersOn: ['failure'],
  },
)

let readySummaryPrinted = false
let frontendReady = false
let backendReady = false

// Only show the Ready banner once the app has truly loaded: the frontend
// (Vite) must be serving AND the backend must have finished its full startup
// sequence (through step 6, signalled by "[startup] Startup complete").
function printReadySummary() {
  if (readySummaryPrinted) return
  if (!frontendReady || !backendReady) return
  readySummaryPrinted = true
  printDivider('Ready')
  printSummaryLine('LoopTroop App', `→  http://localhost:${frontendPort}`)
  printSummaryLine('Documentation', `→  ${effectiveDocsOrigin}/docs/`)
  printDivider('Open the app')
}

for (const command of commands) {
  command.stateChange.subscribe((state) => {
    if (state === 'started') {
      console.log(`[dev] Service ${command.name} started.`)
    }
  })

  // Detect when the WEB (Vite) service is ready.
  if (command.name === 'WEB') {
    command.stdout.subscribe((data) => {
      const output = data.toString()
      if (output.includes('ready in') || output.includes('Local:')) {
        frontendReady = true
        printReadySummary()
      }
    })
  }

  // Detect when the API backend has completed its startup sequence (step 6).
  if (command.name === 'API') {
    command.stdout.subscribe((data) => {
      const output = data.toString()
      if (output.includes('Startup complete')) {
        backendReady = true
        printReadySummary()
      }
    })
  }

  command.error.subscribe((error) => {
    const message = getErrorMessage(error)
    console.error(`[dev] Service ${command.name} failed to spawn: ${message}`)
  })

  command.close.subscribe((event) => {
    const duration = formatDuration(event.timings.durationSeconds)

    if (shutdownSignal) {
      console.log(`[dev] Service ${command.name} stopped after ${duration} (${shutdownSignal}).`)
      return
    }

    if (event.killed) {
      const exitCode = event.exitCode == null ? 'unknown' : String(event.exitCode)
      console.log(`[dev] Service ${command.name} was terminated after ${duration} (exit ${exitCode}).`)
      return
    }

    if (event.exitCode === 0) {
      console.log(`[dev] Service ${command.name} stopped cleanly after ${duration}.`)
      return
    }

    const exitCode = event.exitCode == null ? 'unknown' : String(event.exitCode)
    console.log(`[dev] Service ${command.name} exited with ${exitCode} after ${duration}.`)
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shutdownSignal) {
      return
    }

    shutdownSignal = signal
    shutdownStartedAtMs = Date.now()
    printDivider('Shutdown')
    console.log(`[dev] Received ${signal}; stopping dev services...`)
    for (const command of commands) {
      try {
        command.kill(signal)
      } catch {
        // Ignore shutdown races.
      }
    }
  })
}

try {
  await result
  if (shutdownSignal) {
    const shutdownDuration = shutdownStartedAtMs == null
      ? '0s'
      : formatDuration((Date.now() - shutdownStartedAtMs) / 1000)
    console.log(`[dev] Shutdown complete in ${shutdownDuration}.`)
  }
  process.exit(0)
} catch {
  if (shutdownSignal) {
    const shutdownDuration = shutdownStartedAtMs == null
      ? '0s'
      : formatDuration((Date.now() - shutdownStartedAtMs) / 1000)
    console.log(`[dev] Shutdown complete in ${shutdownDuration}.`)
    process.exit(0)
  }

  process.exit(1)
}
