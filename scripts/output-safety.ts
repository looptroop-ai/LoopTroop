import type { Channel } from './package-manifests.ts'

/** Escapes content before placing it in a Markdown table cell. */
export function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|')
}

/** Matches the finite set of install-channel reports without compiling input as a regex. */
export function doctorReportsInstallChannel(report: string, channel: Channel): boolean {
  if (channel === 'homebrew') return /install\b.*\bhomebrew\b/.test(report)
  if (channel === 'scoop') return /install\b.*\bscoop\b/.test(report)
  return false
}
