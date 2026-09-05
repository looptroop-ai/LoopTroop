import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The version in the root `package.json`, for a build-time `define`.
 *
 * The client used to get this by importing the manifest itself, which put every
 * script, devDependency and engines entry into `dist/client` to render one
 * string. The server has always compiled its version in as
 * `__LOOPTROOP_VERSION__`; this is the same idea for the browser bundle, and it
 * lives here so the Vite and Vitest configs read it the same way.
 */
export function readPackageVersion(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version?: string
  }
  if (typeof manifest.version !== 'string') {
    throw new Error('package.json has no version to compile into the client bundle.')
  }
  return manifest.version
}
