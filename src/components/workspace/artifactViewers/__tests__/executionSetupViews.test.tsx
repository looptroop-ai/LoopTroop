import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { ExecutionSetupPlanView } from '../executionSetupViews'

const defaultStep = {
  id: 'prepare-runtime',
  title: 'Prepare runtime',
  purpose: 'Prepare the workspace runtime.',
  commands: [],
  required: true,
  rationale: '',
  cautions: [],
}

function buildRawPlan({
  status = 'partial',
  actionsRequired = true,
  gaps = ['Workspace setup outputs are still missing.'],
  steps = [defaultStep],
}: {
  status?: 'ready' | 'partial' | 'missing'
  actionsRequired?: boolean
  gaps?: string[]
  steps?: typeof defaultStep[]
} = {}) {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: 'LOOP-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Prepare the workspace runtime.',
    readiness: {
      status,
      actions_required: actionsRequired,
      evidence: ['Repository files were detected.'],
      gaps,
    },
    temp_roots: ['.ticket/runtime/execution-setup'],
    workspace_inputs: [],
    workspace_probes: [],
    git_hooks: { policy: 'future_policy', detected: [], validation_commands: [] },
    steps,
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

  it.each([
    {
      status: 'ready' as const,
      actionsRequired: false,
      gaps: [],
      steps: [],
      label: 'Ready',
      tone: 'border-green-300/70',
      emptyGaps: 'No unresolved setup gaps remain.',
    },
    {
      status: 'partial' as const,
      gaps: [],
      label: 'Partial',
      tone: 'border-amber-300/70',
      emptyGaps: 'No explicit setup gaps were recorded.',
    },
    {
      status: 'missing' as const,
      gaps: [],
      label: 'Missing',
      tone: 'border-red-300/70',
      emptyGaps: 'No explicit setup gaps were recorded.',
    },
  ])('shows $label readiness and matching empty-gap state', ({ status, actionsRequired, gaps, steps, label, tone, emptyGaps }) => {
    renderWithProviders(<ExecutionSetupPlanView content={buildRawPlan({ status, actionsRequired, gaps, steps })} />)

    const readinessCard = screen.getByText('Readiness').parentElement
    expect(readinessCard).toHaveTextContent(label)
    expect(readinessCard).toHaveClass(tone)
    fireEvent.click(screen.getByRole('button', { name: /open gaps/i }))
    expect(screen.getByText(emptyGaps)).toBeInTheDocument()
  })

  it('counts required and optional steps independently', () => {
    renderWithProviders(<ExecutionSetupPlanView content={buildRawPlan({
      steps: [defaultStep, { ...defaultStep, id: 'optional-check', required: false }],
    })} />)

    const requiredCard = screen.getAllByText('Required', { exact: true })[0]?.parentElement
    const optionalCard = screen.getAllByText('Optional', { exact: true })[0]?.parentElement
    expect(screen.getByText('Steps').parentElement).toHaveTextContent('2')
    expect(requiredCard).toHaveTextContent('1')
    expect(optionalCard).toHaveTextContent('1')
  })

  it.each([undefined, '{malformed'])('uses plan details when report content is absent or malformed', (reportContent) => {
    renderWithProviders(<ExecutionSetupPlanView content={buildRawPlan()} reportContent={reportContent} />)

    expect(screen.getAllByText('Prepare the workspace runtime.', { exact: true }).length).toBeGreaterThan(0)
    expect(screen.queryByText('Generation Details')).not.toBeInTheDocument()
  })

  it('renders parsed report summary, notes, and model output', () => {
    const reportContent = JSON.stringify({
      ready: true,
      summary: 'Generated setup plan',
      source: 'regenerate',
      errors: ['One generation warning.'],
      notes: ['The plan was regenerated after review.'],
      modelOutput: 'Suggested runtime setup',
    })
    renderWithProviders(<ExecutionSetupPlanView content={buildRawPlan()} reportContent={reportContent} />)

    expect(screen.getByText('Generated setup plan')).toBeInTheDocument()
    expect(screen.getByText('Regenerated draft')).toBeInTheDocument()
    expect(screen.getByText('One generation warning.')).toBeInTheDocument()
    expect(screen.getByText('The plan was regenerated after review.')).toBeInTheDocument()
    expect(screen.getByText('Suggested runtime setup')).toBeInTheDocument()
  })
})
