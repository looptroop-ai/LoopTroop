#!/usr/bin/env node
/**
 * Puts the container pull commands into a release's notes.
 *
 *   node scripts/release-container-notes.ts \
 *     --version 0.5.0 --index-digest sha256:<index> \
 *     --dh-image docker.io/looptroopai/looptroop \
 *     --ghcr-image ghcr.io/looptroop-ai/looptroop \
 *     --in body.md --out body-next.md
 *
 * File in, file out. The `gh release view` and `gh release edit` around it stay
 * in the workflow, so this needs no token and the splice — which is the part
 * with rules — stays testable against a string.
 *
 * The draft written by `draft-release` deliberately says nothing about a
 * container, because it exists before any image does. This runs only once one
 * has been published and proven.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { spliceContainerBlock } from './container-notes.ts'

interface Options {
  version: string
  indexDigest: string
  dhImage: string
  ghcrImage: string
  input: string
  output: string
}

function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {}
  const flags = ['--version', '--index-digest', '--dh-image', '--ghcr-image', '--in', '--out']
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (!flags.includes(arg)) throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    const value = (argv[i + 1] ?? '').trim()
    i += 1
    if (value === '') throw new Error(`${arg} needs a value`)
    values[arg] = value
  }
  for (const flag of flags) {
    if (values[flag] === undefined) throw new Error(`${flag} is required`)
  }
  return {
    version: values['--version']!,
    indexDigest: values['--index-digest']!,
    dhImage: values['--dh-image']!,
    ghcrImage: values['--ghcr-image']!,
    input: values['--in']!,
    output: values['--out']!,
  }
}

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stdout.write('usage: node scripts/release-container-notes.ts --version <x.y.z> --index-digest <sha256:...>\n')
  process.stdout.write('         --dh-image <ref> --ghcr-image <ref> --in <file> --out <file>\n')
  process.exit(2)
}

try {
  const body = readFileSync(options.input, 'utf8')
  const next = spliceContainerBlock(body, {
    version: options.version,
    indexDigest: options.indexDigest,
    // `docker.io/` is implicit in what a user types, and the notes are read by
    // people rather than by a registry client.
    dhRef: options.dhImage.replace(/^docker\.io\//, ''),
    ghcrRef: options.ghcrImage,
  })
  writeFileSync(options.output, next)
  process.stdout.write(`Wrote ${options.output} with the container block for v${options.version}.\n`)
} catch (error) {
  process.stdout.write(`::error::${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
