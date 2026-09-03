import { EventEmitter } from 'node:events'
import type { SpawnSyncReturns } from 'node:child_process'

/**
 * Replays a `spawnSync`-shaped result through an asynchronous child process.
 *
 * The git and GitHub tests describe what a command returns by stubbing
 * `spawnSync`. Network-bound commands now run through `spawn` instead, and a
 * second stub written in a different shape would let the two drift — the whole
 * point of one runner is that a test cannot describe `git fetch` one way and
 * `git status` another. So `spawn` is wired to the same stub, and this turns
 * its answer into the events the async runner listens for.
 */
export function spawnFromSyncResult(result: SpawnSyncReturns<string | Buffer>): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: (chunk?: unknown) => void; on: () => void }
    kill: (signal?: string) => boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: () => {}, on: () => {} }
  child.kill = () => true

  const toBuffer = (value: string | Buffer | null | undefined): Buffer => {
    if (value === null || value === undefined) return Buffer.alloc(0)
    return Buffer.isBuffer(value) ? value : Buffer.from(value)
  }

  // Deferred so the runner has attached its listeners before anything fires.
  setImmediate(() => {
    if (result?.error) {
      child.emit('error', result.error)
      return
    }
    const stdout = toBuffer(result?.stdout)
    const stderr = toBuffer(result?.stderr)
    if (stdout.length > 0) child.stdout.emit('data', stdout)
    if (stderr.length > 0) child.stderr.emit('data', stderr)
    child.emit('close', result?.status ?? 0, result?.signal ?? null)
  })

  return child
}
