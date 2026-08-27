#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.md from what LoopTroop actually redistributes.
 *
 * Scope is every production npm package that ships, including transitive
 * packages bundled into the frontend or distributed with the backend.
 *
 * Run with --check in CI to fail when the committed file is out of date.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeMarkdownTableCell } from './output-safety.ts'

const OUTPUT_PATH = 'THIRD-PARTY-NOTICES.md'
const LICENSE_FILENAMES = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.(md|txt))?$/i
// Emitted by the bundled-packages plugin in vite.config.ts.
const BUNDLED_PACKAGES_MANIFEST = join('dist', 'client', 'bundled-packages.json')

function readManifest(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function resolveLicenseId(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (manifest.license?.type) return manifest.license.type
  if (Array.isArray(manifest.licenses) && manifest.licenses[0]?.type) return manifest.licenses[0].type
  return 'UNKNOWN'
}

/** Upstream licence files vary in line endings; the text itself is unchanged. */
function readNormalized(filePath) {
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim()
}

function findLicenseText(packageDir) {
  let entries
  try {
    entries = readdirSync(packageDir, { withFileTypes: true })
  } catch {
    return null
  }
  const match = entries.find((entry) => entry.isFile() && LICENSE_FILENAMES.test(entry.name))
  if (!match) return null
  try {
    return readNormalized(join(packageDir, match.name))
  } catch {
    return null
  }
}

function resolveCopyright(licenseText, manifest) {
  // Must look like a real notice ("Copyright (c) 2016 X"), not prose that
  // happens to begin with the word: Apache-2.0 boilerplate and its bracketed
  // template line both otherwise win over the actual holder.
  const line = licenseText
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => /^copyright\s+(\(c\)|©|\d{4})/i.test(candidate))
  if (line) return line
  if (typeof manifest.author === 'string') return manifest.author
  if (manifest.author?.name) return manifest.author.name
  return null
}

/** `npm ls --omit=dev` gives the production tree, including transitive packages. */
function collectProductionPackages() {
  const raw = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const tree = JSON.parse(raw)
  const packages = new Map()

  function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      // Unresolved optional peers (drizzle-orm lists pg, mysql2, sqlite3 and
      // friends) appear as empty entries. Nothing is installed, so nothing is
      // redistributed.
      const isInstalled = Boolean(child.version) && !child.missing && !child.extraneous
      if (isInstalled) {
        const key = `${name}@${child.version}`
        if (!packages.has(key)) packages.set(key, { name, version: child.version })
      }
      walk(child)
    }
  }

  walk(tree)
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function findPackageDir(name) {
  const direct = join('node_modules', name)
  return existsSync(direct) ? direct : null
}

/**
 * Packages inlined into the client bundle. They are devDependencies, so the
 * production tree cannot see them, but their code ships inside the published
 * assets and their licences must travel with it.
 */
function collectBundledFrontendPackages() {
  if (!existsSync(BUNDLED_PACKAGES_MANIFEST)) return []

  let names
  try {
    names = JSON.parse(readFileSync(BUNDLED_PACKAGES_MANIFEST, 'utf8'))
  } catch {
    console.error(`FAIL: ${BUNDLED_PACKAGES_MANIFEST} is not readable JSON.`)
    process.exit(1)
  }

  const packages = []
  for (const name of names) {
    const packageDir = findPackageDir(name)
    const manifest = packageDir ? readManifest(packageDir) : null
    // A build artefact naming a package that is no longer installed means the
    // manifest is stale; rebuilding is the fix, so say so rather than guess.
    if (!manifest?.version) {
      console.error(`FAIL: bundled package "${name}" is not installed. Run \`npm run build:client\` and retry.`)
      process.exit(1)
    }
    packages.push({ name, version: manifest.version })
  }
  return packages
}

/** Apache-2.0 section 4(d) requires any NOTICE file to travel with the work. */
function findNoticeText(packageDir) {
  for (const candidate of ['NOTICE', 'NOTICE.txt', 'NOTICE.md']) {
    const noticePath = join(packageDir, candidate)
    if (!existsSync(noticePath)) continue
    try {
      return readNormalized(noticePath)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Groups packages by exact licence text so the file stays readable: most MIT
 * packages differ only in the copyright line, and emitting 88 near-identical
 * texts would bury the differences.
 */
function groupByLicenseText(packages) {
  const groups = new Map()
  for (const entry of packages) {
    if (!entry.licenseText) continue
    const existing = groups.get(entry.licenseText)
    if (existing) existing.push(entry)
    else groups.set(entry.licenseText, [entry])
  }
  return [...groups.entries()]
    .map(([text, members]) => ({ text, members: members.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.members.length - a.members.length || a.members[0].name.localeCompare(b.members[0].name))
}

function render(packages) {
  const lines = [
    '# Third-Party Notices',
    '',
    'LoopTroop redistributes the third-party software and assets listed below.',
    'Each entry retains its original licence, reproduced in full further down',
    'this file.',
    '',
    '> Generated by `npm run licenses:generate`. Do not edit by hand.',
    '',
  ]

  lines.push('## npm Packages', '')
  lines.push(
    `${packages.length} packages are redistributed: runtime dependencies plus the`,
    'frontend packages inlined into the client bundle.',
    '',
  )
  lines.push('| Package | Version | Licence | Copyright |')
  lines.push('| --- | --- | --- | --- |')

  for (const entry of packages) {
    // Escape existing backslashes before adding the Markdown escape for a
    // pipe. Otherwise a copyright ending in `\\|` can consume the inserted
    // escape and split this row into an extra cell.
    const copyright = entry.copyright
      ? escapeMarkdownTableCell(entry.copyright)
      : '—'
    lines.push(`| \`${entry.name}\` | ${entry.version} | ${entry.license} | ${copyright} |`)
  }

  lines.push('')

  const notices = packages.filter((entry) => entry.noticeText)
  if (notices.length > 0) {
    lines.push('## Required Notices', '')
    lines.push('Reproduced as required by the Apache License, Version 2.0, section 4(d).', '')
    for (const entry of notices) {
      lines.push(`### ${entry.name}@${entry.version}`, '')
      lines.push('```text')
      lines.push(entry.noticeText)
      lines.push('```', '')
    }
  }

  const groups = groupByLicenseText(packages)
  lines.push('## Licence Texts', '')

  const missing = packages.filter((entry) => !entry.licenseText)
  if (missing.length > 0) {
    lines.push(
      `${missing.length} package(s) ship no licence file; consult the declared identifier`,
      'in the table above and the upstream repository.',
      '',
    )
  }

  for (const group of groups) {
    const heading = group.members.map((member) => `\`${member.name}@${member.version}\``).join(', ')
    lines.push(`### ${group.members[0].license}`, '')
    lines.push(`Applies to: ${heading}`, '')
    lines.push('```text')
    lines.push(group.text)
    lines.push('```', '')
  }

  return `${lines.join('\n')}\n`
}

const checkOnly = process.argv.includes('--check')

if (!existsSync(BUNDLED_PACKAGES_MANIFEST)) {
  console.error(`FAIL: ${BUNDLED_PACKAGES_MANIFEST} is missing.`)
  console.error('The client bundle inlines frontend packages that the production')
  console.error('dependency tree cannot see. Run `npm run build` first so their')
  console.error('licences are not silently omitted.')
  process.exit(1)
}

const seen = new Set()
const allPackages = [...collectProductionPackages(), ...collectBundledFrontendPackages()]
  .filter((entry) => {
    const key = `${entry.name}@${entry.version}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const packages = allPackages.map((entry) => {
  const packageDir = findPackageDir(entry.name)
  const manifest = packageDir ? readManifest(packageDir) : null
  if (!manifest) return { ...entry, license: 'UNKNOWN', copyright: null, licenseText: null, noticeText: null }
  const licenseText = findLicenseText(packageDir)
  return {
    ...entry,
    license: resolveLicenseId(manifest),
    copyright: resolveCopyright(licenseText, manifest),
    licenseText,
    noticeText: findNoticeText(packageDir),
  }
})

const unknown = packages.filter((entry) => entry.license === 'UNKNOWN')
if (unknown.length > 0) {
  console.error(`FAIL: ${unknown.length} package(s) have no declared licence:\n`)
  for (const entry of unknown) console.error(`  ${entry.name}@${entry.version}`)
  console.error('\nA redistributed package must declare a licence.')
  process.exit(1)
}

const rendered = render(packages)

if (checkOnly) {
  const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : null
  if (existing !== rendered) {
    console.error(`FAIL: ${OUTPUT_PATH} is out of date.`)
    console.error('Run `npm run licenses:generate` and commit the result.')
    process.exit(1)
  }
  console.log(`PASS: ${OUTPUT_PATH} matches the redistributed package set (${packages.length} packages).`)
} else {
  writeFileSync(OUTPUT_PATH, rendered)
  console.log(`Wrote ${OUTPUT_PATH} covering ${packages.length} packages.`)
}
