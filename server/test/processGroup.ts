import { spawn } from 'node:child_process'
import { once } from 'node:events'

/**
 * A POSIX process group whose leader has exited while a process it started
 * runs on: what an OpenCode that died can leave behind. Returns the group id,
 * which is the dead leader's pid. The caller ends it with
 * `process.kill(-pgid, 'SIGKILL')`.
 */
export async function leaderlessProcessGroup(): Promise<number> {
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' })
  await once(leader, 'exit')
  if (leader.pid === undefined) throw new Error('The process group leader reported no pid.')
  return leader.pid
}
