import { renderCommandSpec, type CommandSpec } from '@shared/commandSpec'

/** Reject obvious tool-presence/version checks as functional workspace readiness probes. */
export function isVersionOnlyWorkspaceProbeCommand(command: CommandSpec | string): boolean {
  const trimmed = (typeof command === 'string' ? command : renderCommandSpec(command)).trim()
  if (!trimmed) return false
  // A compound command can include a version diagnostic and still perform a real project check.
  if (/&&|\|\||[;\n]/.test(trimmed)) return false
  const withoutRedirect = trimmed.replace(/\s+(?:\d?>|\d?>>|&>)\s*\S+\s*$/, '').trim()
  return /(?:^|\s)(?:--version|-version|-V|-v|version)\s*$/.test(withoutRedirect)
}
