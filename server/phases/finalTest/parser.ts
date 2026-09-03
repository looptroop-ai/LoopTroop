import { normalizeFinalTestCommandsOutput } from '../../structuredOutput'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import { unwrapTaggedStructuredOutput } from '../parserTaggedStructuredOutput'
import type { CommandSpec } from '@shared/commandSpec'
import type { HostContext } from '@shared/hostContext'

export const FINAL_TEST_COMMANDS_MARKER = '<FINAL_TEST_COMMANDS>'
export const FINAL_TEST_COMMANDS_END = '</FINAL_TEST_COMMANDS>'

export interface FinalTestCommandPlan {
  markerFound: boolean
  commands: CommandSpec[]
  summary: string | null
  testFiles: string[]
  modifiedFiles: string[]
  fileEffects: Array<{ path: string; intent: 'candidate' | 'temporary' | 'unexpected'; reason?: string }>
  testsCount: number | null
  errors: string[]
  repairApplied?: boolean
  repairWarnings?: string[]
  validationError?: string
  retryDiagnostic?: StructuredRetryDiagnostic
}

export function parseFinalTestCommands(output: string, hostContext?: HostContext): FinalTestCommandPlan {
  const parsed = unwrapTaggedStructuredOutput(
    output,
    normalizeFinalTestCommandsOutput(output, hostContext),
    {
      markerStart: FINAL_TEST_COMMANDS_MARKER,
      markerEnd: FINAL_TEST_COMMANDS_END,
    },
  )

  if (!parsed.ok) {
    return {
      markerFound: parsed.markerFound,
      commands: [],
      summary: null,
      testFiles: [],
      modifiedFiles: [],
      fileEffects: [],
      testsCount: null,
      errors: parsed.errors,
      repairApplied: parsed.repairApplied,
      repairWarnings: parsed.repairWarnings,
      validationError: parsed.validationError,
      retryDiagnostic: parsed.retryDiagnostic,
    }
  }

  return {
    markerFound: parsed.markerFound,
    commands: parsed.value.commands,
    summary: parsed.value.summary,
    testFiles: parsed.value.testFiles,
    modifiedFiles: parsed.value.modifiedFiles,
    fileEffects: parsed.value.fileEffects,
    testsCount: parsed.value.testsCount,
    errors: [],
    repairApplied: parsed.repairApplied,
    repairWarnings: parsed.repairWarnings,
  }
}
