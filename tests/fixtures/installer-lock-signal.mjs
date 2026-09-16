#!/usr/bin/env node
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSignalHandlers, withInstallLock } from '../../scripts/installer-core.mjs'

const [directory, mode] = process.argv.slice(2)
if (!directory || !mode) process.exit(2)

const workDir = mkdtempSync(join(tmpdir(), 'looptroop-installer-signal-'))
installSignalHandlers(workDir)

withInstallLock(directory, () => {
  if (mode === 'replacement') writeFileSync(join(directory, '.install.lock'), 'replacement-owner\n')
  const handlers = process.listeners('SIGTERM')
  const handler = handlers[handlers.length - 1]
  if (typeof handler !== 'function') throw new Error('SIGTERM handler was not installed')
  handler()
})
