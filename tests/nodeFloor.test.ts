import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatNodeVersion, parseNodeFloor } from '../shared/nodeFloor'
import {
  NODE_FLOOR_EXACT,
  NODE_FLOOR_MAJOR,
  renderAurPackage,
  renderHomebrewFormula,
  renderNuspec,
} from '../scripts/package-manifests.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8')

const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node
const FLOOR = parseNodeFloor(engines)
const FLOOR_LABEL = formatNodeVersion(FLOOR)

const INPUTS = {
  version: '9.9.9',
  url: 'https://github.com/looptroop-ai/LoopTroop/releases/download/v9.9.9/looptroop-9.9.9-bundle.tar.gz',
  sha256: '3c5fe4640000000000000000000000000000000000000000000000000000abcd',
}

/**
 * §11.5: the Node floor was stated in five places with three different answers,
 * and a machine on 24.15–24.17 passed `doctor` and the read-only install
 * verifier before hitting a launcher that refused to start.
 *
 * `engines.node` is now the only place it is written by hand. Everything below
 * is a copy generated from it or derived from it, and this is what keeps them
 * from drifting apart again between releases — `npm run installers:check` only
 * runs in the release workflow.
 */
describe('the Node floor is stated once', () => {
  it('is a patch-level floor, so every consumer has something to compare', () => {
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+$/)
  })

  // The launcher is covered by `cliLauncher.test.ts`, which runs its guard.

  it('is what both installer wrappers tell a reader to install', () => {
    expect(read('install.sh')).toContain(`LoopTroop needs Node.js ${FLOOR_LABEL} or newer`)
    expect(read('install.ps1')).toContain(`LoopTroop needs Node.js ${FLOOR_LABEL} or newer`)
    expect(read('install.sh')).toContain(`brew install node@${FLOOR.major}`)
  })

  it('is what the read-only install verifier enforces', () => {
    // It reads `engines.node`; this only proves it no longer restates one.
    expect(read('scripts/verify-readonly-install.mjs')).not.toMatch(/REQUIRED_NODE = \{ major: \d/)
  })

  /**
   * Only Chocolatey can express a patch level. Homebrew pins a keg and Arch has
   * no versioned package, so both carry the major — a translation of the same
   * floor, which is why they are asserted against it rather than left alone.
   */
  it('is what each package channel declares, in the form that channel allows', () => {
    expect(NODE_FLOOR_EXACT).toBe(FLOOR_LABEL)
    expect(NODE_FLOOR_MAJOR).toBe(String(FLOOR.major))
    expect(renderNuspec(INPUTS)).toContain(`<dependency id="nodejs-lts" version="${FLOOR_LABEL}" />`)
    expect(renderHomebrewFormula(INPUTS)).toContain(`depends_on "node@${FLOOR.major}"`)
    expect(renderAurPackage(INPUTS)['PKGBUILD']).toContain(`nodejs>=${FLOOR.major}`)
  })
})
