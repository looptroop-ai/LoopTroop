import { readFileSync } from 'node:fs'
import { validateRepositoryCommand } from '../commandEvidence'
import type { ExecutionSetupPlan } from './types'

export function validateGeneratedExecutionSetupPlan(input: {
  plan: ExecutionSetupPlan
  worktreePath: string
  beadsPath: string
}): string[] {
  const commands: Array<{
    source: string
    command: string
    kind: 'bead-test' | 'setup-step' | 'workspace-probe' | 'project-command'
  }> = [
    ...input.plan.workspaceProbes.map((probe) => ({
      source: `workspace probe ${probe.id}`,
      command: probe.command,
      kind: 'workspace-probe' as const,
    })),
    ...input.plan.gitHooks.validationCommands.map((validation) => ({
      source: `Git hook validation ${validation.id}`,
      command: validation.command,
      kind: 'project-command' as const,
    })),
    ...input.plan.projectCommands.prepare.map((command, index) => ({
      source: `project_commands.prepare[${index}]`,
      command,
      kind: 'setup-step' as const,
    })),
    ...input.plan.projectCommands.testFull.map((command, index) => ({
      source: `project_commands.test_full[${index}]`,
      command,
      kind: 'project-command' as const,
    })),
    ...input.plan.projectCommands.lintFull.map((command, index) => ({
      source: `project_commands.lint_full[${index}]`,
      command,
      kind: 'project-command' as const,
    })),
    ...input.plan.projectCommands.typecheckFull.map((command, index) => ({
      source: `project_commands.typecheck_full[${index}]`,
      command,
      kind: 'project-command' as const,
    })),
  ]

  try {
    for (const line of readFileSync(input.beadsPath, 'utf8').split('\n').filter(Boolean)) {
      const bead = JSON.parse(line) as { id?: unknown; testCommands?: unknown }
      if (!Array.isArray(bead.testCommands)) continue
      for (const [index, command] of bead.testCommands.entries()) {
        if (typeof command !== 'string' || !command.trim()) continue
        commands.push({
          source: `bead ${typeof bead.id === 'string' ? bead.id : 'unknown'} testCommands[${index}]`,
          command,
          kind: 'bead-test',
        })
      }
    }
  } catch (error) {
    return [`Failed to validate bead command compatibility: ${error instanceof Error ? error.message : String(error)}`]
  }

  const errors: string[] = []
  const missingLaunchers = new Map<string, string[]>()
  for (const entry of commands) {
    const evidence = validateRepositoryCommand({
      repositoryRoot: input.worktreePath,
      command: entry.command,
      commandKind: entry.kind,
    })
    if (!evidence.valid) {
      errors.push(
        `${entry.source} command "${entry.command}" is incompatible with repository evidence: ${evidence.message ?? evidence.code ?? 'unknown command compatibility failure'}.`,
      )
      continue
    }
    if (evidence.status === 'launcher-missing' && evidence.executable) {
      const sources = missingLaunchers.get(evidence.executable) ?? []
      sources.push(entry.source)
      missingLaunchers.set(evidence.executable, sources)
    }
  }

  if (input.plan.readiness.status === 'ready' && !input.plan.readiness.actionsRequired) {
    for (const [launcher, sources] of missingLaunchers) {
      errors.push(
        `Execution setup plan cannot be ready because required launcher "${launcher}" is unavailable for ${sources.join(', ')}; mark readiness partial or missing and add a setup step.`,
      )
    }
  }
  return [...new Set(errors)]
}
