#!/usr/bin/env node
/**
 * Splits one Vitest run across machines by recorded file time, and proves the
 * machines together ran every file.
 *
 * Vitest's own `--shard` orders the files by a hash of their paths and cuts
 * that order into equal counts, ignoring how long each file takes. That
 * balances badly here: on Windows 32 of the ~550 files hold about two thirds of
 * the test time (they drive real git worktrees), and a split blind to time can
 * hand most of them to one machine. When CI sets `VITEST_SHARD_DIR`, the sequencer in vitest.config.ts
 * calls `assignShards` with the per-file times `main` recorded on its last full
 * run, writes what it chose to `plan.json`, and a reporter writes what actually
 * ran to `report.json`.
 *
 * Splitting is also a new way for CI to lie: a file assigned to no machine, or
 * assigned and never run, would pass silently. The lane's result job therefore
 * runs, in order:
 *
 *   node scripts/test-shards.ts require --dir <downloaded shard artifacts> --count <n>
 *   node scripts/test-shards.ts cover   --dir <same> --count <n>
 *   node scripts/test-shards.ts timings --dir <same> --out <file>   # main only
 *
 * `require` fails unless every shard reported a passing run. `cover` fails
 * unless the shards agree on the full file list and together ran each file
 * exactly once. `timings` writes the measured durations the next run balances
 * on.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SHARD_PLAN_FILE = 'plan.json'
export const SHARD_REPORT_FILE = 'report.json'

/** Repository-relative test file path with forward slashes, like `server/a.test.ts`. */
export type TestFile = string
/** Milliseconds per test file. */
export type Timings = Record<TestFile, number>

export interface ShardPlan {
  version: 1
  index: number
  count: number
  /** Every test file the run collected, sorted. Identical on every shard. */
  all: TestFile[]
  /** The files this shard was given, sorted. */
  files: TestFile[]
}

export interface ShardReportFile {
  file: TestFile
  /** Vitest's module state: passed, failed, skipped, pending or queued. */
  state: string
  durationMs: number
}

export interface ShardReport {
  version: 1
  /** Vitest's run-end reason: passed, failed or interrupted. */
  reason: string
  unhandledErrors: number
  files: ShardReportFile[]
}

export interface ShardResult {
  index: number
  plan?: ShardPlan
  report?: ShardReport
}

/** A path relative to the project root, in the form plans and timings use on every OS. */
export function toTestFile(root: string, absolutePath: string): TestFile {
  return relative(root, absolutePath).split(sep).join('/')
}

/** The phases of one file's run, as Vitest's `TestModule.diagnostic()` reports them, in milliseconds. */
export interface FileDiagnostic {
  environmentSetupDuration: number
  prepareDuration: number
  setupDuration: number
  collectDuration: number
  duration: number
}

/**
 * A file's whole time on its worker. `duration` alone is only its tests and
 * hooks; the environment, the test harness, the setup files and importing the
 * file itself are separate, and on Windows they are most of the cost.
 */
export function fileDuration(diagnostic: FileDiagnostic): number {
  return diagnostic.environmentSetupDuration + diagnostic.prepareDuration + diagnostic.setupDuration
    + diagnostic.collectDuration + diagnostic.duration
}

/** Code-unit order, which every machine shares; `localeCompare` follows the runner's locale, and both shards must agree. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Longest-processing-time-first: the slowest file goes to the least loaded
 * shard, then the next. Ties break on the path and the lower shard index, so
 * every machine computes the same split from the same inputs. A file with no
 * recorded time counts as the median recorded file, and as 1 ms when nothing
 * is recorded at all, which degrades to an even split by count. Every file
 * weighs at least 1 ms: a 0 would leave the least loaded shard least loaded,
 * and every zero-time file would pile onto it.
 */
export function assignShards(files: readonly TestFile[], timings: Timings, count: number): TestFile[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer, not ${count}.`)
  const unique = [...new Set(files)].sort(byCodeUnit)
  const usable = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const known = unique.map((file) => timings[file]).filter(usable)
  const fallback = known.length === 0 ? 1 : median(known)
  const weighted = unique.map((file) => {
    const recorded = timings[file]
    return { file, weight: Math.max(1, usable(recorded) ? recorded : fallback) }
  }).sort((a, b) => b.weight - a.weight || byCodeUnit(a.file, b.file))
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] as TestFile[] }))
  for (const { file, weight } of weighted) {
    let target = shards[0]!
    for (const shard of shards) if (shard.total < target.total) target = shard
    target.files.push(file)
    target.total += weight
  }
  return shards.map((shard) => shard.files.sort(byCodeUnit))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Recorded timings, or none: a missing or unreadable file only costs balance, never correctness. */
export function readTimings(path: string | undefined): Timings {
  if (!path || !existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0))
  } catch {
    return {}
  }
}

/**
 * Each downloaded artifact directory that holds a plan, keyed by the shard index
 * the plan states. A pattern download that matches a single artifact lands
 * directly in the directory instead of in a folder of its own, so a plan there
 * counts too: that is the case where the other shard never ran.
 */
export function readShardResults(directory: string): ShardResult[] {
  if (!existsSync(directory)) return []
  const results: ShardResult[] = []
  const flat = readJson<ShardPlan>(join(directory, SHARD_PLAN_FILE))
  if (flat) results.push({ index: flat.index, plan: flat, report: readJson<ShardReport>(join(directory, SHARD_REPORT_FILE)) })
  for (const entry of readdirSync(directory).sort(byCodeUnit)) {
    const path = join(directory, entry)
    // An entry gone or dangling since the listing is not a shard; a crash here would hide the verdict.
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue
    const plan = readJson<ShardPlan>(join(path, SHARD_PLAN_FILE))
    if (!plan) continue
    results.push({ index: plan.index, plan, report: readJson<ShardReport>(join(path, SHARD_REPORT_FILE)) })
  }
  return results
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Every shard from 1 to `count` reported, and its run passed. Returns the problems, if any. */
export function checkShardsPassed(results: readonly ShardResult[], count: number): string[] {
  const problems: string[] = []
  for (let index = 1; index <= count; index += 1) {
    const matching = results.filter((result) => result.index === index)
    if (matching.length === 0) {
      problems.push(`Shard ${index}/${count} never reported: the job did not run, was cancelled, or stopped before Vitest started.`)
      continue
    }
    if (matching.length > 1) {
      problems.push(`Shard ${index}/${count} reported ${matching.length} times.`)
      continue
    }
    const { plan, report } = matching[0]!
    if (plan?.count !== count) problems.push(`Shard ${index}/${count} was planned as one of ${plan?.count} shards.`)
    if (!report) {
      problems.push(`Shard ${index}/${count} wrote a plan but no report: Vitest did not finish.`)
      continue
    }
    if (report.reason !== 'passed') problems.push(`Shard ${index}/${count} finished as "${report.reason}".`)
    if (report.unhandledErrors > 0) problems.push(`Shard ${index}/${count} had ${report.unhandledErrors} unhandled error(s).`)
    // `?? []`: a report that parses but lacks its list is a problem to report, not a crash.
    if (!Array.isArray(report.files)) problems.push(`Shard ${index}/${count} wrote a report without its list of files.`)
    for (const file of report.files ?? []) {
      if (file.state === 'failed') problems.push(`Shard ${index}/${count}: ${file.file} failed.`)
      else if (file.state !== 'passed' && file.state !== 'skipped') problems.push(`Shard ${index}/${count}: ${file.file} never finished (${file.state}).`)
    }
  }
  return problems
}

/**
 * The shards agree on the full list, the plans split it exactly, and each
 * shard ran exactly the files it was given. Returns the problems, if any.
 */
export function checkShardCoverage(results: readonly ShardResult[], count: number): string[] {
  const problems: string[] = []
  const plans = results.map((result) => result.plan).filter((plan): plan is ShardPlan => plan !== undefined)
  // Exactly one plan per shard 1..count, so the check also holds when run on its own, without `require` first.
  const indices = plans.map((plan) => plan.index).sort((a, b) => a - b)
  if (indices.length !== count || indices.some((index, position) => index !== position + 1)) {
    return [`Expected one plan for each shard 1 to ${count}, found ${indices.length === 0 ? 'none' : indices.join(', ')}.`]
  }
  for (const plan of plans) if (plan.count !== count) problems.push(`Shard ${plan.index} was planned as one of ${plan.count} shards.`)
  for (const { index, plan, report } of results) if (plan && !report) problems.push(`Shard ${index} wrote a plan but no report.`)
  const all = plans[0]!.all
  if (all.length === 0) problems.push('The shards collected no test files at all.')
  for (const plan of plans) {
    if (!sameList(plan.all, all)) problems.push(`Shard ${plan.index} collected a different file list from shard ${plans[0]!.index}.`)
  }
  const owners = new Map<TestFile, number[]>()
  for (const plan of plans) {
    for (const file of plan.files) owners.set(file, [...owners.get(file) ?? [], plan.index])
  }
  for (const file of all) {
    const owner = owners.get(file) ?? []
    if (owner.length === 0) problems.push(`${file} was assigned to no shard.`)
    if (owner.length > 1) problems.push(`${file} was assigned to shards ${owner.join(', ')}.`)
  }
  for (const file of owners.keys()) {
    if (!all.includes(file)) problems.push(`${file} was assigned but is not in the collected list.`)
  }
  for (const { index, plan, report } of results) {
    if (!plan || !report) continue
    const ran = new Set((report.files ?? []).map((file) => file.file))
    for (const file of plan.files) if (!ran.has(file)) problems.push(`Shard ${index} was given ${file} but never ran it.`)
    for (const file of ran) if (!plan.files.includes(file)) problems.push(`Shard ${index} ran ${file}, which it was not given.`)
  }
  return problems
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** The measured duration of every file any shard ran. */
export function mergeTimings(results: readonly ShardResult[]): Timings {
  const timings: Timings = {}
  for (const { report } of results) {
    for (const file of report?.files ?? []) {
      if (Number.isFinite(file.durationMs) && file.durationMs >= 0) timings[file.file] = Math.round(file.durationMs)
    }
  }
  return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => byCodeUnit(a, b)))
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** Exit status for the CLI; output goes to the given writers so tests can read it. */
export function main(args: readonly string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  const [command] = args
  const directory = option(args, '--dir')
  if (!directory || !['require', 'cover', 'timings'].includes(command ?? '')) {
    err('usage: node scripts/test-shards.ts require|cover --dir <shard artifacts> --count <n>')
    err('       node scripts/test-shards.ts timings --dir <shard artifacts> --out <file>')
    return 2
  }
  const results = readShardResults(directory)
  if (command === 'timings') {
    const target = option(args, '--out')
    if (!target) {
      err('timings needs --out <file>.')
      return 2
    }
    const timings = mergeTimings(results)
    writeJson(target, timings)
    out(`Recorded ${Object.keys(timings).length} file timings to ${target}.`)
    return 0
  }
  const count = Number(option(args, '--count'))
  if (!Number.isInteger(count) || count < 1) {
    err('--count must be a positive integer.')
    return 2
  }
  const problems = command === 'require' ? checkShardsPassed(results, count) : checkShardCoverage(results, count)
  if (problems.length > 0) {
    for (const problem of problems) err(`::error::${problem}`)
    return 1
  }
  if (command === 'require') out(`All ${count} shards ran and passed.`)
  else out(`The ${count} shards together ran all ${results[0]!.plan!.all.length} test files, each exactly once.`)
  return 0
}

/** Through realpath, as in check-node-feeds.ts, so a symlinked checkout still runs the CLI. */
function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return import.meta.url === pathToFileURL(invoked).href
  }
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2))
