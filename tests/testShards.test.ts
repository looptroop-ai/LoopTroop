import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assignShards,
  checkShardCoverage,
  checkShardsPassed,
  fileDuration,
  main,
  mergeTimings,
  readShardResults,
  readTimings,
  SHARD_PLAN_FILE,
  SHARD_REPORT_FILE,
  toTestFile,
  writeJson,
  type ShardPlan,
  type ShardReport,
  type ShardResult,
} from '../scripts/test-shards'

const directories: string[] = []
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-test-shards-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const ALL = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']

function plan(index: number, files: string[], all = ALL, count = 2): ShardPlan {
  return { version: 1, index, count, all, files }
}

function report(files: string[], overrides: Partial<ShardReport> = {}, state = 'passed'): ShardReport {
  return { version: 1, reason: 'passed', unhandledErrors: 0, files: files.map((file) => ({ file, state, durationMs: 100 })), ...overrides }
}

function result(index: number, files: string[], reportFiles = files): ShardResult {
  return { index, plan: plan(index, files), report: report(reportFiles) }
}

function writeShard(root: string, name: string, shardPlan?: ShardPlan, shardReport?: ShardReport) {
  mkdirSync(join(root, name), { recursive: true })
  if (shardPlan) writeJson(join(root, name, SHARD_PLAN_FILE), shardPlan)
  if (shardReport) writeJson(join(root, name, SHARD_REPORT_FILE), shardReport)
}

describe('assignShards', () => {
  it('puts the slowest files on different shards and balances the totals', () => {
    const timings = { 'slow.test.ts': 270_000, 'medium.test.ts': 110_000, 'a.test.ts': 60_000, 'b.test.ts': 50_000, 'c.test.ts': 40_000 }
    const [first, second] = assignShards(Object.keys(timings), timings, 2)
    expect(first).toEqual(['slow.test.ts'])
    expect(second).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts', 'medium.test.ts'])
  })

  it('is deterministic whatever order the files arrive in, and drops duplicates', () => {
    const timings = { 'a.test.ts': 5, 'b.test.ts': 5, 'c.test.ts': 5, 'd.test.ts': 5 }
    const forward = assignShards(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'], timings, 2)
    const backward = assignShards(['d.test.ts', 'c.test.ts', 'b.test.ts', 'a.test.ts', 'a.test.ts'], timings, 2)
    expect(backward).toEqual(forward)
    expect(forward.flat().sort()).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'])
  })

  it('weighs an unrecorded file as the median recorded file', () => {
    const timings = { 'a.test.ts': 100, 'b.test.ts': 10, 'c.test.ts': 30 }
    // new.test.ts weighs 30: a (100) | c (30) + new (30) + b (10).
    expect(assignShards(['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'], timings, 2))
      .toEqual([['a.test.ts'], ['b.test.ts', 'c.test.ts', 'new.test.ts']])
  })

  it('uses the mean of the two middle values for an even number of recordings', () => {
    const timings = { 'a.test.ts': 100, 'b.test.ts': 40, 'c.test.ts': 20, 'd.test.ts': 2 }
    // new.test.ts weighs (40 + 20) / 2 = 30, which goes beside b (40) rather than a (100).
    const [first, second] = assignShards([...Object.keys(timings), 'new.test.ts'], timings, 2)
    expect(first).toEqual(['a.test.ts'])
    expect(second).toEqual(['b.test.ts', 'c.test.ts', 'd.test.ts', 'new.test.ts'])
  })

  it('splits evenly by count when nothing was recorded', () => {
    const shards = assignShards(['a', 'b', 'c', 'd', 'e'], {}, 2)
    expect(shards.map((shard) => shard.length).sort()).toEqual([2, 3])
  })

  it('ignores recorded values that are not usable durations', () => {
    const timings = { 'a.test.ts': Number.NaN, 'b.test.ts': -5, 'c.test.ts': 7 } as Record<string, number>
    const shards = assignShards(['a.test.ts', 'b.test.ts', 'c.test.ts'], timings, 3)
    expect(shards.flat().sort()).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
    expect(shards.every((shard) => shard.length === 1)).toBe(true)
  })

  // At 0 ms a file leaves the least loaded shard least loaded, so every
  // zero-time file would land there.
  it('weighs every file at least 1 ms, so zero-time files still spread out', () => {
    const zero = { 'a.test.ts': 0, 'b.test.ts': 0, 'c.test.ts': 0, 'd.test.ts': 0 }
    expect(assignShards(Object.keys(zero), zero, 2)).toEqual([['a.test.ts', 'c.test.ts'], ['b.test.ts', 'd.test.ts']])
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses a shard count of %s', (count) => {
    expect(() => assignShards(['a'], {}, count)).toThrow('Shard count must be a positive integer')
  })
})

describe('readTimings', () => {
  it('returns nothing for a missing, unreadable, or non-object file', () => {
    const directory = scratch()
    expect(readTimings(undefined)).toEqual({})
    expect(readTimings(join(directory, 'absent.json'))).toEqual({})
    writeFileSync(join(directory, 'broken.json'), '{ not json')
    expect(readTimings(join(directory, 'broken.json'))).toEqual({})
    writeFileSync(join(directory, 'array.json'), '[1, 2]')
    expect(readTimings(join(directory, 'array.json'))).toEqual({})
    writeFileSync(join(directory, 'null.json'), 'null')
    expect(readTimings(join(directory, 'null.json'))).toEqual({})
  })

  it('keeps only non-negative finite numbers', () => {
    const directory = scratch()
    writeFileSync(join(directory, 'timings.json'), JSON.stringify({ 'a.test.ts': 12, 'b.test.ts': -1, 'c.test.ts': 'slow', 'd.test.ts': 0 }))
    expect(readTimings(join(directory, 'timings.json'))).toEqual({ 'a.test.ts': 12, 'd.test.ts': 0 })
  })
})

describe('checkShardsPassed', () => {
  it('passes when every shard reported a passing run', () => {
    expect(checkShardsPassed([result(1, ['a.test.ts', 'b.test.ts']), result(2, ['c.test.ts', 'd.test.ts'])], 2)).toEqual([])
  })

  it('names a shard that never reported, one that reported twice, and one that wrote no report', () => {
    const problems = checkShardsPassed([
      result(1, ['a.test.ts']),
      result(1, ['a.test.ts']),
      { index: 3, plan: plan(3, ['c.test.ts'], ALL, 3) },
    ], 3)
    expect(problems).toEqual([
      'Shard 1/3 reported 2 times.',
      'Shard 2/3 never reported: the job did not run, was cancelled, or stopped before Vitest started.',
      'Shard 3/3 wrote a plan but no report: Vitest did not finish.',
    ])
  })

  it('names failed files, a failed or interrupted run, unhandled errors, and a plan for another count', () => {
    const failing: ShardResult = {
      index: 1,
      plan: plan(1, ['a.test.ts', 'b.test.ts'], ALL, 4),
      report: { version: 1, reason: 'interrupted', unhandledErrors: 2, files: [
        { file: 'a.test.ts', state: 'failed', durationMs: 1 },
        { file: 'b.test.ts', state: 'skipped', durationMs: 1 },
        { file: 'c.test.ts', state: 'pending', durationMs: 0 },
        { file: 'd.test.ts', state: 'queued', durationMs: 0 },
      ] },
    }
    expect(checkShardsPassed([failing, result(2, ['c.test.ts'])], 2)).toEqual([
      'Shard 1/2 was planned as one of 4 shards.',
      'Shard 1/2 finished as "interrupted".',
      'Shard 1/2 had 2 unhandled error(s).',
      'Shard 1/2: a.test.ts failed.',
      'Shard 1/2: c.test.ts never finished (pending).',
      'Shard 1/2: d.test.ts never finished (queued).',
    ])
  })
})

describe('checkShardCoverage', () => {
  it('passes when the shards split the full list exactly and ran what they were given', () => {
    expect(checkShardCoverage([result(1, ['a.test.ts', 'c.test.ts']), result(2, ['b.test.ts', 'd.test.ts'])], 2)).toEqual([])
  })

  it('fails when a plan is missing, doubled, or numbered outside 1 to count', () => {
    expect(checkShardCoverage([result(1, ALL)], 2)).toEqual(['Expected one plan for each shard 1 to 2, found 1.'])
    expect(checkShardCoverage([result(1, ['a.test.ts', 'c.test.ts']), result(1, ['b.test.ts', 'd.test.ts'])], 2))
      .toEqual(['Expected one plan for each shard 1 to 2, found 1, 1.'])
    expect(checkShardCoverage([result(1, ['a.test.ts', 'c.test.ts']), result(3, ['b.test.ts', 'd.test.ts'])], 2))
      .toEqual(['Expected one plan for each shard 1 to 2, found 1, 3.'])
    expect(checkShardCoverage([], 2)).toEqual(['Expected one plan for each shard 1 to 2, found none.'])
  })

  // `require` catches both first in CI; on its own, cover must not pass them.
  it('fails a plan made for another count, and a plan with no report', () => {
    const otherCount: ShardResult = { index: 2, plan: plan(2, ['b.test.ts', 'd.test.ts'], ALL, 3), report: report(['b.test.ts', 'd.test.ts']) }
    expect(checkShardCoverage([result(1, ['a.test.ts', 'c.test.ts']), otherCount], 2)).toEqual(['Shard 2 was planned as one of 3 shards.'])
    const noReport: ShardResult = { index: 2, plan: plan(2, ['b.test.ts', 'd.test.ts']) }
    expect(checkShardCoverage([result(1, ['a.test.ts', 'c.test.ts']), noReport], 2)).toEqual(['Shard 2 wrote a plan but no report.'])
  })

  it('fails when nothing was collected', () => {
    const empty = [{ index: 1, plan: plan(1, [], []), report: report([]) }, { index: 2, plan: plan(2, [], []), report: report([]) }]
    expect(checkShardCoverage(empty, 2)).toEqual(['The shards collected no test files at all.'])
  })

  it('names files dropped, doubled, unknown, unrun or run without being assigned', () => {
    const first: ShardResult = { index: 1, plan: plan(1, ['a.test.ts', 'b.test.ts', 'e.test.ts']), report: report(['a.test.ts', 'x.test.ts']) }
    const second: ShardResult = { index: 2, plan: plan(2, ['b.test.ts'], [...ALL].reverse()), report: report(['b.test.ts']) }
    expect(checkShardCoverage([first, second], 2)).toEqual([
      'Shard 2 collected a different file list from shard 1.',
      'b.test.ts was assigned to shards 1, 2.',
      'c.test.ts was assigned to no shard.',
      'd.test.ts was assigned to no shard.',
      'e.test.ts was assigned but is not in the collected list.',
      'Shard 1 was given b.test.ts but never ran it.',
      'Shard 1 was given e.test.ts but never ran it.',
      'Shard 1 ran x.test.ts, which it was not given.',
    ])
  })
})

describe('mergeTimings and the artifact layout', () => {
  it('records every file any shard ran, rounded and sorted', () => {
    const merged = mergeTimings([
      { index: 1, report: { version: 1, reason: 'passed', unhandledErrors: 0, files: [{ file: 'b.test.ts', state: 'passed', durationMs: 10.6 }] } },
      { index: 2, report: { version: 1, reason: 'passed', unhandledErrors: 0, files: [
        { file: 'a.test.ts', state: 'passed', durationMs: 3.2 },
        { file: 'c.test.ts', state: 'passed', durationMs: Number.NaN },
      ] } },
      { index: 3 },
    ])
    expect(Object.entries(merged)).toEqual([['a.test.ts', 3], ['b.test.ts', 11]])
  })

  it('reads one result per artifact directory that holds a plan', () => {
    const root = scratch()
    writeShard(root, 'test-windows-toolchain-shard-1', plan(1, ['a.test.ts']), report(['a.test.ts']))
    writeShard(root, 'test-windows-toolchain-shard-2', plan(2, ['b.test.ts']))
    writeShard(root, 'unrelated')
    writeFileSync(join(root, 'stray-file.txt'), '')
    mkdirSync(join(root, 'corrupt'))
    writeFileSync(join(root, 'corrupt', SHARD_PLAN_FILE), '{')
    expect(readShardResults(root)).toEqual([
      { index: 1, plan: plan(1, ['a.test.ts']), report: report(['a.test.ts']) },
      { index: 2, plan: plan(2, ['b.test.ts']), report: undefined },
    ])
    expect(readShardResults(join(root, 'absent'))).toEqual([])
  })

  // A pattern download that matches one artifact extracts it without a folder.
  it('reads a lone artifact extracted straight into the directory', () => {
    const root = scratch()
    writeJson(join(root, SHARD_PLAN_FILE), plan(2, ['b.test.ts']))
    writeJson(join(root, SHARD_REPORT_FILE), report(['b.test.ts']))
    expect(readShardResults(root)).toEqual([{ index: 2, plan: plan(2, ['b.test.ts']), report: report(['b.test.ts']) }])
    expect(checkShardsPassed(readShardResults(root), 2)).toEqual([
      'Shard 1/2 never reported: the job did not run, was cancelled, or stopped before Vitest started.',
    ])
  })

  it('times a file from its environment setup to its last test', () => {
    expect(fileDuration({ environmentSetupDuration: 400, prepareDuration: 30, setupDuration: 200, collectDuration: 1500, duration: 70 })).toBe(2200)
  })

  it('writes paths relative to the project root with forward slashes', () => {
    const root = resolve(scratch())
    expect(toTestFile(root, join(root, 'server', 'git', 'x.test.ts'))).toBe('server/git/x.test.ts')
  })
})

describe('the command line', () => {
  function run(args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const status = main(args, (line) => out.push(line), (line) => err.push(line))
    return { status, out, err }
  }

  it('prints usage for an unknown command or a missing directory', () => {
    expect(run(['bogus', '--dir', 'x']).status).toBe(2)
    expect(run(['cover']).err[0]).toContain('usage:')
  })

  it('requires a positive --count and an --out for timings', () => {
    const root = scratch()
    expect(run(['require', '--dir', root]).err).toEqual(['--count must be a positive integer.'])
    expect(run(['cover', '--dir', root, '--count', '0']).status).toBe(2)
    expect(run(['timings', '--dir', root])).toMatchObject({ status: 2, err: ['timings needs --out <file>.'] })
  })

  it('passes require and cover for a complete run and records its timings', () => {
    const root = scratch()
    writeShard(root, 'shard-1', plan(1, ['a.test.ts', 'c.test.ts']), report(['a.test.ts', 'c.test.ts']))
    writeShard(root, 'shard-2', plan(2, ['b.test.ts', 'd.test.ts']), report(['b.test.ts', 'd.test.ts']))
    expect(run(['require', '--dir', root, '--count', '2'])).toMatchObject({ status: 0, out: ['All 2 shards ran and passed.'] })
    expect(run(['cover', '--dir', root, '--count', '2']))
      .toMatchObject({ status: 0, out: ['The 2 shards together ran all 4 test files, each exactly once.'] })
    const target = join(root, 'out', 'timings.json')
    expect(run(['timings', '--dir', root, '--out', target]).out[0]).toContain('Recorded 4 file timings')
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ 'a.test.ts': 100, 'b.test.ts': 100, 'c.test.ts': 100, 'd.test.ts': 100 })
  })

  it('fails require with an annotation per problem when a shard is missing', () => {
    const root = scratch()
    writeShard(root, 'shard-1', plan(1, ALL), report(ALL))
    const failed = run(['require', '--dir', root, '--count', '2'])
    expect(failed.status).toBe(1)
    expect(failed.err).toEqual(['::error::Shard 2/2 never reported: the job did not run, was cancelled, or stopped before Vitest started.'])
  })

  it('fails cover when a file was never run', () => {
    const root = scratch()
    writeShard(root, 'shard-1', plan(1, ['a.test.ts', 'c.test.ts']), report(['a.test.ts']))
    writeShard(root, 'shard-2', plan(2, ['b.test.ts', 'd.test.ts']), report(['b.test.ts', 'd.test.ts']))
    expect(run(['cover', '--dir', root, '--count', '2']))
      .toMatchObject({ status: 1, err: ['::error::Shard 1 was given c.test.ts but never ran it.'] })
  })
})
