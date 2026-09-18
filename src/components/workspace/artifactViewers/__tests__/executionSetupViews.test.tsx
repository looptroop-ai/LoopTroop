import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { ExecutionSetupPlanView } from '../executionSetupViews'

function buildRawPlan() {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: 'LOOP-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Prepare the workspace runtime.',
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Repository files were detected.'],
      gaps: ['Workspace setup outputs are still missing.'],
    },
    temp_roots: ['.ticket/runtime/execution-setup'],
    workspace_inputs: [],
    workspace_probes: [],
    git_hooks: { policy: 'future_policy', detected: [], validation_commands: [] },
    steps: [],
    project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: [],
  }, null, 2)
}

describe('ExecutionSetupPlanView', () => {
  it('renders an unknown hook policy warning in the artifact view', () => {
    renderWithProviders(<ExecutionSetupPlanView content={buildRawPlan()} />)

    expect(screen.getByText(/git_hooks\.policy: unknown value/i)).toBeInTheDocument()
    expect(screen.getByText(/safe fallback values/i)).toBeInTheDocument()
  })
})
