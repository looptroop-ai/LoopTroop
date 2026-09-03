import type { BeadChecks } from './completionSchema'
import { BEAD_STATUS_END, BEAD_STATUS_MARKER, REQUIRED_GATES } from './completionSchema'
import { normalizeBeadCompletionMarkerOutput } from '../../structuredOutput'
import { unwrapTaggedStructuredOutput } from '../parserTaggedStructuredOutput'

export interface CompletionResult {
  complete: boolean
  markerFound: boolean
  gatesValid: boolean
  beadId?: string
  checks?: BeadChecks
  errors: string[]
  repairApplied?: boolean
  repairWarnings?: string[]
  validationError?: string
}

export function parseCompletionMarker(output: string, expectedBeadId?: string): CompletionResult {
  const errors: string[] = []
  const parsed = unwrapTaggedStructuredOutput(output, normalizeBeadCompletionMarkerOutput(output), {
    markerStart: BEAD_STATUS_MARKER,
    markerEnd: BEAD_STATUS_END,
  })
  if (!parsed.ok) {
    return {
      complete: false,
      markerFound: parsed.markerFound,
      gatesValid: false,
      errors: parsed.errors,
      repairApplied: parsed.repairApplied,
      repairWarnings: parsed.repairWarnings,
      validationError: parsed.validationError,
    }
  }

  // A marker naming a different bead used to mark the running bead done. The id
  // is the only thing tying the model's report to the work it was given.
  if (expectedBeadId !== undefined && parsed.value.beadId !== expectedBeadId) {
    const mismatchError = `Completion marker reports bead "${parsed.value.beadId}" but the running bead is "${expectedBeadId}"`
    return {
      complete: false,
      markerFound: true,
      gatesValid: false,
      // The bead this result is about is the one that was running. Reporting the
      // marker's id here would hand a diagnostic consumer the wrong bead.
      beadId: expectedBeadId,
      checks: parsed.value.checks,
      errors: [mismatchError],
      repairApplied: parsed.repairApplied,
      repairWarnings: parsed.repairWarnings,
      validationError: mismatchError,
    }
  }

  const isComplete = parsed.value.status === 'done'
  const isFailed = parsed.value.status === 'error'

  // Validate quality gates
  const checks = parsed.value.checks
  let gatesValid = true

  for (const gate of REQUIRED_GATES) {
    if (typeof checks[gate] !== 'string') {
      errors.push(`Missing quality gate: ${gate}`)
      gatesValid = false
    } else if (checks[gate] !== 'pass') {
      errors.push(`Quality gate failed: ${gate} = ${checks[gate]}`)
      gatesValid = false
    }
  }

  if (isFailed) {
    errors.push(`Bead reported status: ${parsed.value.status}`)
  }

  // Marker says complete but gates fail → treat as incomplete per spec
  if (isComplete && !gatesValid) {
    errors.push('Marker says completed but quality gates failed — treating as incomplete')
  }

  return {
    complete: isComplete && gatesValid,
    markerFound: true,
    gatesValid,
    beadId: parsed.value.beadId,
    checks,
    errors,
    repairApplied: parsed.repairApplied,
    repairWarnings: parsed.repairWarnings,
  }
}
