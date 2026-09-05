/**
 * How this copy of LoopTroop was installed.
 *
 * The server detects it and the update banner renders from it, so both sides
 * spelled the union out. A channel added on one side and not the other compiled
 * cleanly and then failed at runtime on whichever half had not heard of it.
 */
export const INSTALL_CHANNELS = [
  'npm',
  'bun',
  'pnpm',
  'yarn',
  'homebrew',
  'scoop',
  'chocolatey',
  'winget',
  'aur',
  'binary',
  'container',
  'source',
  'unknown',
] as const

export type InstallChannel = (typeof INSTALL_CHANNELS)[number]

/**
 * File an installer may drop at the package root to state the channel outright.
 *
 * Homebrew, Scoop and Chocolatey all extract the same bundle, so nothing about
 * the files themselves distinguishes them; only the manager that unpacked them
 * knows, and this is where it says so. Deliberately at the package root rather
 * than beside the detector, because detection runs from `dist/server/lib` and an
 * installer has no business knowing that.
 *
 * Here rather than in either half because it is a contract between them: the
 * packaging scripts write this filename and the server reads it, and they held
 * separate literals — a rename on one side would have orphaned the other with
 * nothing failing, since a marker that is absent is simply an unknown channel.
 */
export const INSTALL_CHANNEL_MARKER = '.install-channel'

/** One published release, as the update check reports it. */
export interface ReleaseDetails {
  version: string
  name: string
  url: string
  publishedAt: string | null
  notes: string
}
