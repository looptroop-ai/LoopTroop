import type { ProcessMatch } from '../server/lib/processIdentity'

export interface ProcessInfo {
  pid: number
  ppid: number
  args: string
}

export interface ProcessGraph {
  byPid: Map<number, ProcessInfo>
  childrenByPid: Map<number, ProcessInfo[]>
}

export function parseProcessTable(output: string): ProcessInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) {
        return []
      }

      return [{
        pid: Number(match[1]),
        ppid: Number(match[2]),
        args: match[3]!,
      }]
    })
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
}

export function buildProcessGraph(processes: ProcessInfo[]): ProcessGraph {
  const byPid = new Map<number, ProcessInfo>()
  const childrenByPid = new Map<number, ProcessInfo[]>()

  for (const process of processes) {
    byPid.set(process.pid, process)
    const children = childrenByPid.get(process.ppid) ?? []
    children.push(process)
    childrenByPid.set(process.ppid, children)
  }

  return { byPid, childrenByPid }
}

function normalizeCommandLine(args: string): string {
  return args.trim().replace(/\\/g, '/').replace(/\s+/g, ' ')
}

function normalizePathFragment(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function getPathFragmentVariants(path: string): string[] {
  const normalized = normalizePathFragment(path)
  const variants = new Set<string>([normalized])
  const wslDriveMatch = normalized.match(/^\/mnt\/([a-z])\/(.+)$/i)
  if (wslDriveMatch) {
    variants.add(`${wslDriveMatch[1]?.toUpperCase()}:/${wslDriveMatch[2]}`)
  }

  const windowsDriveMatch = normalized.match(/^([a-z]):\/(.+)$/i)
  if (windowsDriveMatch) {
    variants.add(`/mnt/${windowsDriveMatch[1]?.toLowerCase()}/${windowsDriveMatch[2]}`)
  }

  return [...variants]
}

function isFragmentBoundary(char?: string) {
  return char == null || /[\s"'=:/\\()[\]{}]/.test(char)
}

function containsCommandFragment(command: string, fragment: string): boolean {
  let index = command.indexOf(fragment)

  while (index >= 0) {
    const before = index === 0 ? undefined : command[index - 1]
    const afterIndex = index + fragment.length
    const after = afterIndex >= command.length ? undefined : command[afterIndex]

    if (isFragmentBoundary(before) && isFragmentBoundary(after)) {
      return true
    }

    index = command.indexOf(fragment, index + 1)
  }

  return false
}

export function isLoopTroopDevProcess(args: string, repoRoot: string): boolean {
  const command = normalizeCommandLine(args)
  const repoPathMarkers = getPathFragmentVariants(repoRoot).flatMap((root) => [
    `${root}/scripts/dev.ts`,
    `${root}/scripts/dev-backend.ts`,
    `${root}/node_modules/.bin/vite`,
    `${root}/node_modules/.bin/vite.cmd`,
    `${root}/node_modules/.bin/concurrently`,
    `${root}/node_modules/.bin/concurrently.cmd`,
    `${root}/scripts/dev-opencode.ts`,
    `${root}/server/index.ts`,
  ])
  const repoMarkers = [
    ...repoPathMarkers,
    'scripts/dev.ts',
    'scripts/dev-backend.ts',
    'node_modules/.bin/vite',
    'node_modules/.bin/vite.cmd',
    'node_modules/.bin/concurrently',
    'node_modules/.bin/concurrently.cmd',
    'scripts/dev-opencode.ts',
    'tsx watch server/index.ts',
    'server/index.ts',
    'npm run dev:opencode',
    'npm run dev:frontend',
    'npm run dev:backend',
    'npm:dev:opencode',
    'npm:dev:frontend',
    'npm:dev:backend',
  ]

  return repoMarkers.some((marker) => containsCommandFragment(command, normalizePathFragment(marker)))
}

export function findOwningRootProcess(
  process: ProcessInfo,
  graph: ProcessGraph,
  repoRoot: string,
): ProcessInfo | null {
  let current: ProcessInfo | undefined = process
  let root: ProcessInfo | null = isLoopTroopDevProcess(process.args, repoRoot) ? process : null

  while (current) {
    const parent = graph.byPid.get(current.ppid)
    if (!parent) break

    if (isLoopTroopDevProcess(parent.args, repoRoot)) {
      root = parent
    }

    current = parent
  }

  return root
}

export function collectProcessTree(rootPid: number, graph: ProcessGraph): ProcessInfo[] {
  const ordered: ProcessInfo[] = []
  const visited = new Set<number>()

  const visit = (pid: number) => {
    if (visited.has(pid)) return
    visited.add(pid)

    for (const child of graph.childrenByPid.get(pid) ?? []) {
      visit(child.pid)
    }

    const process = graph.byPid.get(pid)
    if (process) {
      ordered.push(process)
    }
  }

  visit(rootPid)
  return ordered
}

export function resolveProcessTreesToTerminate(
  processes: ProcessInfo[],
  occupantPids: number[],
  repoRoot: string,
): {
  roots: ProcessInfo[]
  unrelatedOccupants: ProcessInfo[]
} {
  const graph = buildProcessGraph(processes)
  const roots = new Map<number, ProcessInfo>()
  const unrelatedOccupants: ProcessInfo[] = []

  for (const occupantPid of occupantPids) {
    const occupant = graph.byPid.get(occupantPid)
    if (!occupant) continue

    const root = findOwningRootProcess(occupant, graph, repoRoot)
    if (!root) {
      unrelatedOccupants.push(occupant)
      continue
    }

    roots.set(root.pid, root)
  }

  return {
    roots: [...roots.values()],
    unrelatedOccupants,
  }
}

export function formatProcessSummary(process: ProcessInfo): string {
  return `pid=${process.pid} ppid=${process.ppid} args=${process.args}`
}

/** The parts of daemon.json this decision reads. */
export interface DaemonProtectionState {
  pid: number
  startToken?: string
  opencode?: {
    owned?: boolean
    pid?: number
    startToken?: string
  }
}

export interface DaemonProtectionDeps {
  isProcessAlive: (pid: number) => boolean
  matchProcess: (pid: number, recordedToken: string | undefined) => ProcessMatch
}

export interface DaemonProtectionDecision {
  /** Pids preflight must not terminate; the caller protects each one's tree. */
  pids: number[]
  /** Why a decision differs from what the record alone would have said. */
  warnings: string[]
}

/**
 * Which pids from daemon.json a dev preflight must leave alone.
 *
 * A `looptroop start` daemon is a real user session whose process tree is
 * indistinguishable from a stale dev tree, so it has to be protected by name.
 * The name is a pid, and a pid is not an identity: a daemon that died without
 * clearing its record — SIGKILL, a crash, a laptop that lost power — leaves a
 * number behind that the kernel hands to something else. Protecting on liveness
 * alone then protects whatever inherited it, and because the whole subtree is
 * protected with it, one recycled pid belonging to a shell or a supervisor can
 * shield every stale dev process on the machine. Preflight cleans nothing and
 * `npm run dev` fails on a port it was supposed to reclaim.
 *
 * The unverifiable case resolves the opposite way to `stop` and `clean`, which
 * refuse to act without proof. Those commands signal processes, so uncertainty
 * must stop them. This one decides whether to spare a process, and the costs are
 * not symmetric: sparing a stranger wastes a port, while killing an unverified
 * daemon takes down the session a user is working in. So `unknown` protects, and
 * only a positive mismatch withdraws protection.
 */
export function decideDaemonProtection(
  state: DaemonProtectionState | null,
  deps: DaemonProtectionDeps,
): DaemonProtectionDecision {
  if (!state) return { pids: [], warnings: [] }
  // A record whose pid is gone is the ordinary residue of a daemon that did not
  // shut down cleanly. There is nothing to protect and nothing to report.
  if (!deps.isProcessAlive(state.pid)) return { pids: [], warnings: [] }

  const match = deps.matchProcess(state.pid, state.startToken)
  if (match.kind === 'different') {
    return {
      pids: [],
      warnings: [
        `daemon.json names pid ${state.pid}, which now belongs to a different process. ` +
        'Treating it as a stale record rather than as a running daemon.',
      ],
    }
  }

  const pids = [state.pid]
  const warnings = match.kind === 'unknown'
    ? [`Protecting the daemon at pid ${state.pid} without verifying it: ${match.reason}.`]
    : []

  const opencode = state.opencode
  if (opencode?.owned && typeof opencode.pid === 'number' && opencode.pid > 0) {
    // Usually a child of the daemon, and so already inside the protected tree.
    // Named separately for the case where the process table cannot show that.
    const childMatch = deps.matchProcess(opencode.pid, opencode.startToken)
    if (childMatch.kind === 'different') {
      warnings.push(
        `daemon.json names an OpenCode server at pid ${opencode.pid}, which now belongs to a ` +
        'different process. It will not be protected.',
      )
    } else {
      pids.push(opencode.pid)
    }
  }

  return { pids, warnings }
}

