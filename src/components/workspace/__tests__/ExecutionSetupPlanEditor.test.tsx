import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionSetupPlan } from '@/lib/executionSetupPlan'
import { ExecutionSetupPlanEditor } from '../ExecutionSetupPlanEditor'

function buildPlan(): ExecutionSetupPlan {
  return {
    schemaVersion: 2,
    ticketId: 'TEST-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Verify the workspace.',
    hostContext: {
      platform: 'linux',
      environment: 'wsl',
      arch: 'x64',
      availableShells: ['posix'],
      preferredShell: 'posix',
    },
    readiness: { status: 'ready', actionsRequired: false, evidence: [], gaps: [] },
    tempRoots: [],
    workspaceInputs: [],
    workspaceProbes: [{ id: 'workspace', command: { mode: 'process', program: 'project', args: ['test', '--list'], cwd: '.', env: {} }, purpose: 'Load the project.' }],
    gitHooks: {
      policy: 'validate_advisory',
      detected: [{ name: 'pre-commit', path: '.husky/pre-commit', source: 'husky', kind: 'manager_config', runnable: 'unknown', managerHint: 'husky' }],
      validationCommands: [
        { id: 'lint', hook: 'pre-commit', command: { mode: 'process', program: 'project', args: ['lint'], cwd: '.', env: {} }, purpose: 'Run lint.' },
        { id: 'test', hook: 'pre-commit', command: { mode: 'process', program: 'project', args: ['test'], cwd: '.', env: {} }, purpose: 'Run tests.' },
      ],
    },
    steps: [],
    projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [] },
    qualityGatePolicy: { tests: '', lint: '', typecheck: '', fullProjectFallback: '' },
    cautions: [],
  }
}

function latestPlan(onChange: ReturnType<typeof vi.fn>): ExecutionSetupPlan {
  return onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan
}

describe('ExecutionSetupPlanEditor workspace verification', () => {
  it('exposes whether each setup step is expanded', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ExecutionSetupPlanEditor plan={buildPlan()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    rerender(<ExecutionSetupPlanEditor plan={onChange.mock.calls.at(-1)![0]} onChange={onChange} />)

    const first = screen.getByRole('button', { name: /Setup Step 1/ })
    expect(first).not.toHaveAccessibleName(/[▼▶]/)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(first.getAttribute('aria-controls')!)
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Remove Step' }))
    expect(panel).not.toContainElement(first)
    fireEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(first).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('button', { name: 'Remove Step' })).not.toBeInTheDocument()
    fireEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    rerender(<ExecutionSetupPlanEditor plan={onChange.mock.calls.at(-1)![0]} onChange={onChange} />)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Setup Step 2/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps discovered hooks read-only and allows validation commands to be edited, reordered, and removed', () => {
    const onChange = vi.fn()
    const plan = buildPlan()
    const { rerender } = render(<ExecutionSetupPlanEditor plan={plan} onChange={onChange} />)

    expect(screen.getByText('Detected Git Hooks (read-only)')).toBeInTheDocument()
    expect(screen.getByText('Git Hook Policy (read-only)')).toBeInTheDocument()
    expect(screen.getByLabelText('Locked Git hook policy')).toHaveTextContent('Check — warn if validation fails')
    expect(screen.queryByRole('combobox', { name: /Git Hook Policy/i })).not.toBeInTheDocument()
    expect(screen.getByText('.husky/pre-commit')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('.husky/pre-commit')).not.toBeInTheDocument()
    expect(screen.getByText('manager configuration')).toBeInTheDocument()
    expect(screen.getByText('runnable: unknown')).toBeInTheDocument()
    expect(screen.getByLabelText('Current setup host')).toHaveTextContent('wsl')

    fireEvent.click(screen.getByRole('button', { name: 'Move Git Hook Validation Commands 2 up' }))
    const reordered = onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan
    expect(reordered.gitHooks.validationCommands.map((entry) => entry.id)).toEqual(['test', 'lint'])

    rerender(<ExecutionSetupPlanEditor plan={reordered} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Git Hook Validation Commands 1 command program'), { target: { value: 'project-test' } })
    expect((onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan).gitHooks.validationCommands.at(0)?.command).toMatchObject({ program: 'project-test' })

    let current = onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan
    rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Git Hook Validation Commands 1' }))
    current = onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan
    rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Git Hook Validation Commands 1' }))
    expect((onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan).gitHooks.validationCommands).toEqual([])
  })

  it('adds workspace probes and hook validations with editable identity, purpose, and order', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ExecutionSetupPlanEditor plan={buildPlan()} onChange={onChange} />)
    const sync = () => {
      const current = latestPlan(onChange)
      rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
      return current
    }
    const workspaceProbes = () => within(
      screen.getByText('Workspace Probes').parentElement!.parentElement!.parentElement!,
    )

    fireEvent.click(workspaceProbes().getByRole('button', { name: 'Add' }))
    let current = sync()
    expect(current.workspaceProbes[1]).toMatchObject({
      id: 'workspace-probe-2',
      purpose: '',
      command: { mode: 'process', program: '', args: [], cwd: '.', env: {} },
    })
    fireEvent.change(screen.getByLabelText('Workspace Probes 2 id'), { target: { value: 'start-check' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Workspace Probes 2 purpose'), { target: { value: 'Confirm dependencies are available.' } })
    current = sync()
    fireEvent.click(workspaceProbes().getByRole('button', { name: 'Move Workspace Probes 1 down' }))
    current = sync()
    expect(current.workspaceProbes.map((probe) => probe.id)).toEqual(['start-check', 'workspace'])

    const hookValidations = () => within(
      screen.getByText('Git Hook Validation Commands').parentElement!.parentElement!.parentElement!,
    )
    fireEvent.click(hookValidations().getByRole('button', { name: 'Add' }))
    current = sync()
    expect(current.gitHooks.validationCommands[2]).toMatchObject({
      id: 'git-hook-validation-3',
      hook: '',
      purpose: '',
      command: { mode: 'process', program: '', args: [], cwd: '.', env: {} },
    })
    fireEvent.change(screen.getByLabelText('Git Hook Validation Commands 3 hook'), { target: { value: 'pre-push' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Git Hook Validation Commands 3 purpose'), { target: { value: 'Check the final diff.' } })
    current = sync()
    expect(current.gitHooks.validationCommands[2]).toMatchObject({ hook: 'pre-push', purpose: 'Check the final diff.' })
  })

  it('adds workspace inputs, edits their reviewed details, and restores readiness when removed', () => {
    const onChange = vi.fn()
    const plan = buildPlan()
    plan.readiness = {
      status: 'missing',
      actionsRequired: true,
      evidence: [],
      gaps: ['A local fixture is needed.'],
    }
    const { rerender } = render(<ExecutionSetupPlanEditor plan={plan} onChange={onChange} />)
    const workspaceInputs = () => within(
      screen.getByText('Workspace Inputs').parentElement!.parentElement!,
    )
    const sync = () => {
      const current = latestPlan(onChange)
      rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
      return current
    }

    expect(screen.getByText('No ignored or untracked workspace inputs are approved.')).toBeInTheDocument()
    fireEvent.click(workspaceInputs().getByRole('button', { name: 'Add' }))
    let current = sync()
    expect(current.workspaceInputs).toEqual([{
      path: '',
      kind: 'file',
      sourceStatus: 'ignored',
      category: 'other_non_reproducible',
      reason: '',
    }])
    expect(current.readiness).toMatchObject({ status: 'missing', actionsRequired: true })

    fireEvent.change(screen.getByLabelText('Workspace input 1 path'), { target: { value: 'fixtures/local.db' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Workspace input 1 kind'), { target: { value: 'directory' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Workspace input 1 source status'), { target: { value: 'untracked' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Workspace input 1 category'), { target: { value: 'fixture' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Workspace input 1 reason'), { target: { value: 'Local test data.' } })
    current = sync()
    fireEvent.click(screen.getByLabelText('Workspace input 1 allow large copy'))
    current = sync()

    expect(current.workspaceInputs[0]).toMatchObject({
      path: 'fixtures/local.db',
      kind: 'directory',
      sourceStatus: 'untracked',
      category: 'fixture',
      reason: 'Local test data.',
      allowLargeCopy: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace input 1' }))
    current = sync()
    expect(current.workspaceInputs).toEqual([])
    expect(current.readiness).toMatchObject({ status: 'ready', actionsRequired: false, gaps: [] })
  })

  it('edits plan notes, readiness lists, quality gates, and project command groups', () => {
    const onChange = vi.fn()
    const plan = buildPlan()
    plan.readiness = { status: 'missing', actionsRequired: true, evidence: [], gaps: [] }
    const { rerender } = render(<ExecutionSetupPlanEditor plan={plan} onChange={onChange} />)
    const sync = () => {
      const current = latestPlan(onChange)
      rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
      return current
    }

    fireEvent.change(screen.getByDisplayValue('Verify the workspace.'), { target: { value: 'Prepare the local workspace.' } })
    let current = sync()
    expect(current.summary).toBe('Prepare the local workspace.')

    const tempRoots = within(screen.getByText('Temp Roots').parentElement!)
    fireEvent.click(tempRoots.getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(screen.getByPlaceholderText('.ticket/runtime/execution-setup or .ticket/runtime/execution-setup/tool-cache'), {
      target: { value: '.ticket/runtime/setup-cache' },
    })
    current = sync()
    expect(current.tempRoots).toEqual(['.ticket/runtime/setup-cache'])

    const readinessStatus = () => within(screen.getByText('Readiness Status').parentElement!).getByRole('combobox')
    fireEvent.change(readinessStatus(), { target: { value: 'partial' } })
    current = sync()
    expect(current.readiness).toMatchObject({ status: 'partial', actionsRequired: true })

    const evidence = () => within(screen.getByText('Observed Evidence').parentElement!)
    fireEvent.click(evidence().getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(screen.getByPlaceholderText('Observed repository or runtime evidence...'), {
      target: { value: 'The package lockfile is present.' },
    })
    current = sync()
    expect(current.readiness.evidence).toEqual(['The package lockfile is present.'])

    const gaps = () => within(screen.getByText('Open Gaps').parentElement!)
    fireEvent.click(gaps().getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(screen.getByPlaceholderText('Missing prerequisite or unresolved setup gap...'), {
      target: { value: 'A local database fixture is still needed.' },
    })
    current = sync()
    expect(current.readiness.gaps).toEqual(['A local database fixture is still needed.'])

    const planCautions = () => within(screen.getByText('Plan Cautions').parentElement!)
    fireEvent.click(planCautions().getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(planCautions().getByPlaceholderText('Potential risk or caveat...'), {
      target: { value: 'The fixture contains local-only data.' },
    })
    current = sync()
    expect(current.cautions).toEqual(['The fixture contains local-only data.'])

    fireEvent.change(screen.getByPlaceholderText('bead-test-commands-first'), { target: { value: 'focused-tests-first' } })
    current = sync()
    fireEvent.change(screen.getAllByPlaceholderText('impacted-or-package')[0]!, { target: { value: 'impacted-lint-first' } })
    current = sync()
    fireEvent.change(screen.getAllByPlaceholderText('impacted-or-package')[1]!, { target: { value: 'impacted-typecheck-first' } })
    current = sync()
    fireEvent.change(screen.getByPlaceholderText('never-block-on-unrelated-baseline'), { target: { value: 'report unrelated failures' } })
    current = sync()
    expect(current.qualityGatePolicy).toEqual({
      tests: 'focused-tests-first',
      lint: 'impacted-lint-first',
      typecheck: 'impacted-typecheck-first',
      fullProjectFallback: 'report unrelated failures',
    })

    const projectCommandGroups = [
      ['Prepare / Bootstrap Commands', 'prepare'],
      ['Full Test Commands', 'testFull'],
      ['Full Lint Commands', 'lintFull'],
      ['Full Typecheck Commands', 'typecheckFull'],
    ] as const
    for (const [title, key] of projectCommandGroups) {
      fireEvent.click(within(screen.getByText(title).parentElement!).getByRole('button', { name: '+ Command' }))
      current = sync()
      expect(current.projectCommands[key]).toHaveLength(1)
    }

    fireEvent.change(readinessStatus(), { target: { value: 'ready' } })
    current = sync()
    expect(current.readiness).toMatchObject({ status: 'ready', actionsRequired: false, gaps: [] })
  })

  it('edits an added setup step command across process and shell modes, then removes the final action', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ExecutionSetupPlanEditor plan={buildPlan()} onChange={onChange} />)
    const sync = () => {
      const current = latestPlan(onChange)
      rerender(<ExecutionSetupPlanEditor plan={current} onChange={onChange} />)
      return current
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    let current = sync()
    expect(current.steps[0]).toMatchObject({ id: 'setup-step-1', title: 'Setup Step 1', required: true })
    expect(current.readiness).toMatchObject({ status: 'partial', actionsRequired: true })

    fireEvent.change(screen.getByDisplayValue('Setup Step 1'), { target: { value: 'Install dependencies' } })
    current = sync()
    fireEvent.change(within(screen.getByText('Step Id').parentElement!).getByRole('textbox'), {
      target: { value: 'install-dependencies' },
    })
    current = sync()
    fireEvent.change(within(screen.getByText('Purpose').parentElement!).getByRole('textbox'), {
      target: { value: 'Prepare local dependencies.' },
    })
    current = sync()
    fireEvent.change(within(screen.getByText('Rationale').parentElement!).getByRole('textbox'), {
      target: { value: 'The checks need installed packages.' },
    })
    current = sync()
    const stepCautions = () => within(screen.getByText('Step Cautions').parentElement!)
    fireEvent.click(stepCautions().getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(stepCautions().getByPlaceholderText('Optional caution...'), {
      target: { value: 'Keep setup offline.' },
    })
    current = sync()
    expect(current.steps[0]?.cautions).toEqual(['Keep setup offline.'])
    fireEvent.click(stepCautions().getByRole('button', { name: '×' }))
    current = sync()
    expect(current.steps[0]?.cautions).toEqual([])

    fireEvent.click(within(screen.getByText('Commands').parentElement!).getByRole('button', { name: '+ Command' }))
    current = sync()
    expect(current.steps[0]?.commands[0]).toEqual({ mode: 'process', program: '', args: [], cwd: '.', env: {} })

    const stepCommands = within(screen.getByText('Commands').parentElement!)
    fireEvent.click(within(stepCommands.getByText('Arguments').parentElement!).getByRole('button', { name: '+ Add' }))
    current = sync()
    fireEvent.change(within(stepCommands.getByText('Arguments').parentElement!).getByPlaceholderText('One argument (spaces are preserved)'), {
      target: { value: 'install --offline' },
    })
    current = sync()
    expect(current.steps[0]?.commands[0]?.args).toEqual(['install --offline'])

    fireEvent.change(screen.getByLabelText('Setup command 1 working directory'), { target: { value: 'packages/app' } })
    current = sync()
    expect(current.steps[0]?.commands[0]?.cwd).toBe('packages/app')

    fireEvent.change(screen.getByLabelText('Setup command 1 mode'), { target: { value: 'shell' } })
    current = sync()
    expect(current.steps[0]?.commands[0]).toMatchObject({ mode: 'shell', shell: 'posix', script: '', cwd: 'packages/app', env: {} })
    fireEvent.change(screen.getByLabelText('Setup command 1 shell'), { target: { value: 'powershell' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Setup command 1 script'), { target: { value: 'npm install' } })
    current = sync()
    fireEvent.change(screen.getByLabelText('Setup command 1 timeout'), { target: { value: '2500' } })
    current = sync()
    expect(current.steps[0]?.commands[0]).toMatchObject({ shell: 'powershell', script: 'npm install', timeoutMs: 2500 })

    fireEvent.change(screen.getByLabelText('Setup command 1 timeout'), { target: { value: '' } })
    current = sync()
    expect(current.steps[0]?.commands[0]).not.toHaveProperty('timeoutMs')
    fireEvent.change(screen.getByLabelText('Setup command 1 mode'), { target: { value: 'process' } })
    current = sync()
    expect(current.steps[0]?.commands[0]).toMatchObject({ mode: 'process', program: '', args: [], cwd: 'packages/app', env: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Setup command 1' }))
    current = sync()
    expect(current.steps[0]?.commands).toEqual([])

    fireEvent.click(screen.getByLabelText('Required step'))
    current = sync()
    expect(current.steps[0]?.required).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    current = sync()
    expect(current.steps).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Step' }))
    current = sync()
    expect(current.steps).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Step' }))
    current = sync()
    expect(current.steps).toEqual([])
    expect(current.readiness).toMatchObject({ status: 'ready', actionsRequired: false })
  })
})

/**
 * A `Record<string, string>` cannot describe an environment mid-edit. Renaming meant
 * deleting one key and adding another, so the row jumped to the end on every
 * keystroke, its React key changed and remounted the field mid-word, and renaming
 * one variable onto another destroyed both.
 */
describe('ExecutionSetupPlanEditor environment variables', () => {
  function renderWithEnv(env: Record<string, string>) {
    const onChange = vi.fn()
    const plan = buildPlan()
    plan.workspaceProbes[0]!.command.env = env
    const view = render(<ExecutionSetupPlanEditor plan={plan} onChange={onChange} />)
    return { onChange, view }
  }

  function latestEnv(onChange: ReturnType<typeof vi.fn>): Record<string, string> | undefined {
    const plan = onChange.mock.calls.at(-1)?.[0] as ExecutionSetupPlan | undefined
    return plan?.workspaceProbes[0]?.command.env
  }

  it('keeps the row in place and the field mounted while a name is retyped', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAZ: 'two' })
    const nameField = screen.getByLabelText('Environment variable 1 name')

    fireEvent.change(nameField, { target: { value: 'FO' } })
    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'FOB' } })

    // Same element throughout: the row was never rebuilt under the cursor.
    expect(screen.getByLabelText('Environment variable 1 name')).toBe(nameField)
    expect(latestEnv(onChange)).toEqual({ FOB: 'one', BAZ: 'two' })
    // And it is still the first row, not moved to the end by a delete-and-reinsert.
    expect(Object.keys(latestEnv(onChange)!)).toEqual(['FOB', 'BAZ'])
  })

  it('refuses a name that another variable already has, and destroys neither', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BAR' } })

    // Both rows are flagged: neither name is the one that has to give way.
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toHaveTextContent('Another variable is already called BAR')
    expect(screen.getByLabelText('Environment variable 1 name')).toHaveValue('BAR')
    expect(screen.getByLabelText('Environment variable 2 value')).toHaveValue('two')
    // The rename was not taken up, so the record is unchanged and there was nothing
    // to emit — the plan still holds FOO and BAR with their own values.
    expect(latestEnv(onChange)).toBeUndefined()
  })

  it('accepts the rename once the collision is resolved', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BAR' } })
    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BARN' } })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(latestEnv(onChange)).toEqual({ BARN: 'one', BAR: 'two' })
  })

  it('removes only the row asked for', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove environment variable 1' }))

    expect(latestEnv(onChange)).toEqual({ BAR: 'two' })
  })

  it('keeps every other edit flowing while a collision is unresolved', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BAR' } })
    // A value typed into the *other* row while the collision stands.
    fireEvent.change(screen.getByLabelText('Environment variable 2 value'), { target: { value: 'edited' } })

    // The collided rename is not taken up, and nothing else is held hostage to it:
    // suppressing every change would let Save persist a plan without this value.
    expect(latestEnv(onChange)).toEqual({ FOO: 'one', BAR: 'edited' })
  })

  it('adopts a plan loaded underneath an unresolved collision', () => {
    const onChange = vi.fn()
    const plan = buildPlan()
    plan.workspaceProbes[0]!.command.env = { FOO: 'one', BAR: 'two' }
    const { rerender } = render(<ExecutionSetupPlanEditor plan={plan} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BAR' } })

    const reloaded = buildPlan()
    reloaded.workspaceProbes[0]!.command.env = { OTHER: 'three' }
    rerender(<ExecutionSetupPlanEditor plan={reloaded} onChange={onChange} />)

    // The stale draft does not survive to overwrite what was loaded.
    expect(screen.getByLabelText('Environment variable 1 name')).toHaveValue('OTHER')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('will not let a cleared name be taken by another row', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    // Clearing a name does not delete the variable — the × does — so the key it holds
    // stays reserved. Without that, renaming the other row onto it wrote one key twice.
    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Environment variable 2 name'), { target: { value: 'FOO' } })

    expect(screen.getByText(/Another variable is already called FOO/)).toBeInTheDocument()
    // Neither rename was taken up, so the record never changed and the plan still
    // holds both variables under their own names.
    expect(latestEnv(onChange)).toBeUndefined()
  })

  it('says so when a row still holds a name it no longer shows', () => {
    renderWithEnv({ FOO: 'one' })

    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: '' } })

    expect(screen.getByRole('alert')).toHaveTextContent('Still saved as FOO')
  })

  it('applies a rename once the name it wanted is freed', () => {
    const { onChange } = renderWithEnv({ FOO: 'one', BAR: 'two' })

    // The way a collision is actually resolved: ask for the taken name, then move the
    // row holding it out of the way.
    fireEvent.change(screen.getByLabelText('Environment variable 1 name'), { target: { value: 'BAR' } })
    fireEvent.change(screen.getByLabelText('Environment variable 2 name'), { target: { value: 'BAZ' } })

    // A single settle pass left row 1 showing BAR, unflagged, while the plan held FOO.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(latestEnv(onChange)).toEqual({ BAR: 'one', BAZ: 'two' })
  })

  it('warns when two names differ only in case', () => {
    const { onChange } = renderWithEnv({ PATH: 'one', OTHER: 'two' })

    fireEvent.change(screen.getByLabelText('Environment variable 2 name'), { target: { value: 'Path' } })

    expect(screen.getAllByRole('status')[0]).toHaveTextContent(/differ only in case/)
    // A warning, not a refusal: both are real variables off Windows, so both are saved.
    expect(latestEnv(onChange)).toEqual({ PATH: 'one', Path: 'two' })
  })

  it('chooses an unused suffix when a new row is added', () => {
    const { onChange } = renderWithEnv({ VARIABLE: 'one', VARIABLE_2: 'two' })
    const workspaceProbeCommand = screen.getByLabelText('Workspace Probes 1 command program')
      .parentElement!.parentElement!.parentElement!

    fireEvent.click(within(workspaceProbeCommand).getByRole('button', { name: '+ Variable' }))

    expect(screen.getByLabelText('Environment variable 3 name')).toHaveValue('VARIABLE_3')
    fireEvent.change(screen.getByLabelText('Environment variable 3 value'), { target: { value: 'three' } })

    expect(latestEnv(onChange)).toEqual({ VARIABLE: 'one', VARIABLE_2: 'two', VARIABLE_3: 'three' })
  })
})
