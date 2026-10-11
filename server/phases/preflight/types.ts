import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'

export type CheckResult = 'pass' | 'fail' | 'warning'

export interface DiagnosticCheck {
  name: string
  category: 'connectivity' | 'git' | 'artifacts' | 'config' | 'graph'
  result: CheckResult
  message: string
  details?: string
  diagnostics?: BlockedErrorDiagnostics | null
  codes?: string[]
}

export interface PreFlightReport {
  passed: boolean
  checks: DiagnosticCheck[]
  criticalFailures: DiagnosticCheck[]
  warnings: DiagnosticCheck[]
}

export interface PreFlightContext {
  lockedMainImplementer: string | null
  lockedMainImplementerVariant: string | null
  maxIterations: number
}
