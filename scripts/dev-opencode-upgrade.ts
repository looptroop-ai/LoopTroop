import {
  readDailyMaintenanceState,
  recordDailyMaintenanceSuccess,
  upgradeOpenCodeCli,
  writeDailyMaintenanceState,
} from './dev-maintenance'

const report = upgradeOpenCodeCli({
  skip: process.env.LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE === '1',
  logPrefix: 'opencode:upgrade',
})

if (report.skipped) {
  console.log('[opencode:upgrade] Skipped OpenCode CLI upgrade because LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1.')
  process.exit(0)
}

if (!report.available) {
  console.log('[opencode:upgrade] Local opencode binary was not found; nothing to upgrade.')
  process.exit(0)
}

if (report.deferred) {
  console.log(`[opencode:upgrade] ${report.deferredReason ?? 'OpenCode upgrade was deferred.'}`)
  process.exit(0)
}

if (report.errors.length > 0) {
  for (const error of report.errors) {
    console.error(`[opencode:upgrade] ${error}`)
  }
  process.exit(1)
}

if (report.upgraded) {
  console.log(
    `[opencode:upgrade] Updated OpenCode CLI ` +
    `${report.versionBefore ?? 'unknown'} -> ${report.versionAfter ?? 'unknown'}` +
    (report.method ? ` via ${report.method}` : '') +
    '.',
  )
} else {
  console.log(
    `[opencode:upgrade] OpenCode CLI is already current at ` +
    `${report.versionAfter ?? report.versionBefore ?? 'unknown'}` +
    (report.method ? ` via ${report.method}` : '') +
    '.',
  )
}

const maintenanceState = readDailyMaintenanceState()
recordDailyMaintenanceSuccess(maintenanceState, 'opencode')
writeDailyMaintenanceState(maintenanceState)
