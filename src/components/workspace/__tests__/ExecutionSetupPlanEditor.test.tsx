import { fireEvent, render, screen } from '@testing-library/react'
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

describe('ExecutionSetupPlanEditor workspace verification', () => {
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
})
