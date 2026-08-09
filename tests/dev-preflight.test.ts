import { describe, expect, it } from 'vitest'
import {
  buildProcessGraph,
  collectProcessTree,
  decideDaemonProtection,
  isLoopTroopDevProcess,
  parseProcessTable,
  resolveProcessTreesToTerminate,
  type DaemonProtectionDeps,
} from '../scripts/dev-preflight-utils'
import { formatPortOccupantSummary } from '../scripts/port-occupants'

const repoRoot = process.cwd()

describe('dev preflight helpers', () => {
  it('detects the repo dev process shapes that the preflight must reclaim', () => {
    expect(isLoopTroopDevProcess(`${repoRoot}/node_modules/.bin/concurrently -n oc,fe,be`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/vite`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/tsx scripts/dev-backend.ts`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/tsx watch server/index.ts`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`sh -c CHOKIDAR_USEPOLLING=1 tsx watch server/index.ts`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/tsx scripts/dev-opencode.ts`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/server/index.ts`, repoRoot)).toBe(true)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/vitest run`, repoRoot)).toBe(false)
    expect(isLoopTroopDevProcess(`node ${repoRoot}/node_modules/.bin/tsx scripts/dev-preflight.ts`, repoRoot)).toBe(false)
    expect(isLoopTroopDevProcess(`python -m http.server 3000`, repoRoot)).toBe(false)
  })

  it('reclaims the owning watcher tree for a spawned server/index.ts occupant', () => {
    const processes = parseProcessTable([
      '100 1 sh -c CHOKIDAR_USEPOLLING=1 tsx watch server/index.ts',
      `101 100 node ${repoRoot}/node_modules/.bin/tsx watch server/index.ts`,
      `102 101 node ${repoRoot}/server/index.ts`,
      `200 1 node ${repoRoot}/node_modules/.bin/vite`,
    ].join('\n'))
    const graph = buildProcessGraph(processes)

    const resolution = resolveProcessTreesToTerminate(processes, [102, 200], repoRoot)
    expect(resolution.roots.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([100, 200])

    const backendTree = collectProcessTree(100, graph).map((entry) => entry.pid)
    expect(backendTree).toEqual([102, 101, 100])
  })

  it('keeps unrelated port occupants out of the cleanup set', () => {
    const processes = parseProcessTable([
      '300 1 python -m http.server 3000',
    ].join('\n'))

    const resolution = resolveProcessTreesToTerminate(processes, [300], repoRoot)
    expect(resolution.roots).toHaveLength(0)
    expect(resolution.unrelatedOccupants.map((entry) => entry.pid)).toEqual([300])
    expect(formatPortOccupantSummary({
      pid: resolution.unrelatedOccupants[0]?.pid,
      command: resolution.unrelatedOccupants[0]?.args,
    })).toBe('python (pid 300, cmd: python -m http.server 3000)')
  })
})

/**
 * The daemon has to be spared by pid, and a pid is not an identity. A daemon
 * that died without clearing daemon.json leaves a number the kernel reassigns,
 * and because the whole subtree of a protected pid is protected too, one
 * recycled number could shield every stale dev process on the machine.
 */
describe('protecting a running daemon from dev preflight', () => {
  const alive = (): boolean => true

  function deps(overrides: Partial<DaemonProtectionDeps> = {}): DaemonProtectionDeps {
    return {
      isProcessAlive: alive,
      matchProcess: () => ({ kind: 'same' }),
      ...overrides,
    }
  }

  it('protects a daemon whose pid is still the recorded process', () => {
    const decision = decideDaemonProtection({ pid: 4242, startToken: 'token' }, deps())

    expect(decision.pids).toEqual([4242])
    expect(decision.warnings).toEqual([])
  })

  it('protects an OpenCode server the daemon owns', () => {
    const decision = decideDaemonProtection(
      { pid: 4242, startToken: 'token', opencode: { owned: true, pid: 4096, startToken: 'child' } },
      deps(),
    )

    expect(decision.pids).toEqual([4242, 4096])
  })

  it('leaves a server the daemon merely adopted out of it', () => {
    // Not the daemon's to hold open, and not preflight's to shield.
    const decision = decideDaemonProtection(
      { pid: 4242, startToken: 'token', opencode: { owned: false, pid: 4096 } },
      deps(),
    )

    expect(decision.pids).toEqual([4242])
  })

  it('protects nothing when there is no record', () => {
    expect(decideDaemonProtection(null, deps())).toEqual({ pids: [], warnings: [] })
  })

  it('says nothing about a record whose process is simply gone', () => {
    const decision = decideDaemonProtection({ pid: 4242, startToken: 'token' }, deps({
      isProcessAlive: () => false,
    }))

    // The residue of a daemon that did not shut down cleanly is not news.
    expect(decision).toEqual({ pids: [], warnings: [] })
  })

  it('withdraws protection once the pid belongs to someone else', () => {
    const decision = decideDaemonProtection({ pid: 4242, startToken: 'token' }, deps({
      matchProcess: () => ({ kind: 'different' }),
    }))

    // Protecting on liveness alone shielded whatever inherited the number, and
    // its whole subtree with it: preflight then cleaned nothing and `npm run
    // dev` failed on a port it was meant to reclaim.
    expect(decision.pids).toEqual([])
    expect(decision.warnings[0]).toContain('now belongs to a different process')
  })

  it('withdraws protection from a recycled OpenCode pid but keeps the daemon', () => {
    const decision = decideDaemonProtection(
      { pid: 4242, startToken: 'token', opencode: { owned: true, pid: 4096, startToken: 'child' } },
      deps({
        matchProcess: (pid) => (pid === 4096 ? { kind: 'different' } : { kind: 'same' }),
      }),
    )

    expect(decision.pids).toEqual([4242])
    expect(decision.warnings[0]).toContain('OpenCode server at pid 4096')
  })

  it('protects an unverifiable daemon rather than risking the session', () => {
    const decision = decideDaemonProtection({ pid: 4242 }, deps({
      matchProcess: () => ({ kind: 'unknown', reason: 'no start-identity token was recorded for it' }),
    }))

    // `stop` and `clean` refuse to act without proof because they signal
    // processes. This decides whether to spare one, so uncertainty has to fall
    // the other way: a wasted port beats killing the session someone is in.
    expect(decision.pids).toEqual([4242])
    expect(decision.warnings[0]).toContain('without verifying it')
  })
})
