import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNodeFloor, type NodeVersion } from '@shared/nodeFloor'

/**
 * The Node floor this build enforces, compiled in rather than read off disk —
 * the same problem `appVersion.ts` solves, and solved the same way, because a
 * single-file build has no `package.json` beside it.
 *
 * It differs in one respect, deliberately. `APP_VERSION` falls back to `0.0.0`,
 * which is wrong but harmless. A floor that fell back to zero would *accept
 * every runtime*, turning `doctor`'s node check into an unconditional pass with
 * nothing on screen to say so. There is no safe placeholder for a floor, so
 * this throws instead: the build always injects the define, and running from
 * source always has `package.json` above it.
 */
declare const __LOOPTROOP_NODE_FLOOR__: string | undefined

function readEnginesFromPackageJson(): string {
  // dist/server/lib/nodeFloor.js -> package root is three levels up, and
  // server/lib/nodeFloor.ts -> two. Both are tried rather than guessing which
  // build this is.
  const here = dirname(fileURLToPath(import.meta.url))
  for (const up of ['../../..', '../..']) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(here, up, 'package.json'), 'utf8')) as {
        name?: string
        engines?: { node?: string }
      }
      // Any `package.json` will parse; only ours is the right answer.
      if (manifest.name === 'looptroop' && typeof manifest.engines?.node === 'string') {
        return manifest.engines.node
      }
    } catch {
      continue
    }
  }
  throw new Error(
    'LoopTroop cannot determine its Node floor: the build did not inject one and no LoopTroop package.json was found.',
  )
}

export const NODE_FLOOR: NodeVersion = parseNodeFloor(
  typeof __LOOPTROOP_NODE_FLOOR__ === 'string'
    ? __LOOPTROOP_NODE_FLOOR__
    : readEnginesFromPackageJson(),
)
