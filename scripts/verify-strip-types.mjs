#!/usr/bin/env node
/**
 * Fails if any release script uses TypeScript that bare `node` cannot run.
 *
 * Everything in `scripts/` is executed by `node scripts/<name>.ts` from a
 * workflow — no build step, no tsx — so Node's own type stripping is the only
 * thing that parses it. Stripping is syntactic: it erases annotations and
 * refuses anything that would need code generated, which includes parameter
 * properties, `enum`, `namespace` and non-`type` `import`/`export =` forms.
 *
 * Nothing else notices. `tsc --noEmit` accepts all of it, and vitest compiles
 * with esbuild, which also accepts all of it — so a `readonly` constructor
 * parameter passed typecheck, passed every test, and then failed in the one
 * place it runs for real.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)))
const failures = []
let checked = 0

for (const entry of readdirSync(scriptsDir).sort()) {
  if (!entry.endsWith('.ts')) continue
  checked += 1
  try {
    stripTypeScriptTypes(readFileSync(join(scriptsDir, entry), 'utf8'), { mode: 'strip' })
  } catch (error) {
    failures.push(`  scripts/${entry}: ${error.message.split('\n')[0]}`)
  }
}

if (failures.length > 0) {
  process.stderr.write('\nFAIL: these scripts cannot be run by bare node.\n\n')
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  process.stderr.write('\nEvery script here is run as `node scripts/<name>.ts` from a workflow.\n')
  process.stderr.write('Rewrite the flagged syntax; typecheck and vitest both accept what node will not.\n')
  process.exit(1)
}

process.stdout.write(`PASS: all ${checked} scripts/*.ts run under node's type stripping.\n`)
