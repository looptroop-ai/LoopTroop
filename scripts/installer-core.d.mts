/**
 * Types for `installer-core.mjs`, which is plain ESM because `install.sh`
 * downloads and runs it with nothing but Node — no build step, no loader.
 *
 * The tests import it as a module, so without this the whole file is `any` and
 * `tsconfig.tests.json` cannot check the callers. Kept beside the source rather
 * than inferred with `allowJs`: inference widens `binaryTarget`'s two-shape
 * return into a single optional-property object, which is exactly the
 * distinction the refusal path depends on.
 */

/** One file attached to a GitHub release. */
export interface ReleaseAsset {
  name: string
  browser_download_url?: string
  size?: number
}

/** The subset of GitHub's release payload the installer reads. */
export interface Release {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

/** What `install.sh` was asked to do. */
export interface InstallerOptions {
  version: string | null
  tarball: string | null
  dryRun: boolean
  binary: boolean
  prefix: string | null
}

/**
 * Either a build target or the reason there is none.
 *
 * A union rather than one object with two optional fields, because every caller
 * branches on which arrived and an optional-property shape lets a caller read
 * `target` on a refusal without complaint.
 */
export type BinaryTarget = { target: string, refusal?: undefined } | { target?: undefined, refusal: string[] }

/** C library flavour, which decides whether a standalone executable can run. */
export type Libc = 'glibc' | 'musl'

/** One option, in the spelling each wrapper takes. */
export interface InstallOption {
  /** As the core parses it, and as `install.sh` forwards it. */
  sh: string
  /** As `install.ps1` declares it in its `param` block. */
  ps: string
  /** The value placeholder, or null for a switch. */
  value: string | null
  help: string | (() => string)
}

export const INSTALL_OPTIONS: InstallOption[]

export function usageLines(style?: 'sh' | 'ps1'): string[]

export function parseArgs(argv: string[]): InstallerOptions

export function binaryTarget(platform: string, arch: string, libc?: Libc): BinaryTarget

export function detectLibc(report?: unknown): Libc

export function binaryAssetName(version: string, target: string): string

export function binaryAssets(
  release: Release,
  target: string,
): { manifest: ReleaseAsset, archive: ReleaseAsset } | null

export function defaultPrefix(env?: NodeJS.ProcessEnv, home?: string): string

export function onPath(dir: string, pathValue?: string): boolean

/** `-1`, `0` or `1`; prereleases sort below the release they precede. */
export function compareVersions(left: string, right: string): number

export function versionOf(release: Release): string

export function installableAssets(
  release: Release,
): { manifest: ReleaseAsset, tarball: ReleaseAsset } | null

export function selectRelease(
  releases: Release[],
  pinned?: string | null,
  installable?: (release: Release) => unknown,
): Release | null

export function satisfiesFloor(have: string, floor: string): boolean

/** A deadline that restarts every time `touch` is called. */
export interface StallGuard {
  signal: AbortSignal
  /** Restart the deadline; called once per arriving chunk. */
  touch: () => void
  /** Stop the deadline, whether or not it fired. */
  release: () => void
  /** The abort reason if this guard fired, else null. */
  reason: () => string | null
}

/** One cmd.exe token, whatever the value contains. */
export function quoteForCmd(value: string): string

export function stallGuard(idleMs: number, what: string): StallGuard

/** Reads a response body to a byte cap, writing chunks out as they arrive. */
export function streamBody(
  response: Response,
  limit: number,
  what: string,
  write: (chunk: Buffer) => void,
  touch: () => void,
): Promise<number>
