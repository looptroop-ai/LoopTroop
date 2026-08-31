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

/** One published release, as the update check reports it. */
export interface ReleaseDetails {
  version: string
  name: string
  url: string
  publishedAt: string | null
  notes: string
}
