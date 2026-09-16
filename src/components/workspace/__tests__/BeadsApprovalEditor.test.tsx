import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BeadsApprovalEditor } from '../BeadsApprovalEditor'

const bead = {
  id: 'B-1',
  title: 'Accessible bead',
  description: 'A bead with labelled fields.',
  prdRefs: [],
  acceptanceCriteria: ['It can be edited.'],
  tests: ['The fields have names.'],
  testCommands: [{ mode: 'process' as const, program: 'npm', args: ['test'], cwd: '.', env: {} }],
  targetFiles: [],
  contextGuidance: { patterns: [], anti_patterns: [] },
  dependencies: { blocked_by: [], blocks: [] },
  status: 'pending',
}

describe('BeadsApprovalEditor accessibility', () => {
  it('exposes disclosure state and labels every structured field', () => {
    render(<BeadsApprovalEditor beads={[bead]} onChange={vi.fn()} />)

    const disclosure = screen.getByRole('button', { name: /Accessible bead/ })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure).not.toHaveAttribute('aria-controls')

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    const panelId = disclosure.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    const panel = document.getElementById(panelId!)
    expect(panel).toHaveAttribute('role', 'region')
    expect(panel).toHaveAttribute('aria-labelledby', disclosure.id)
    expect(screen.getByLabelText('Title')).toHaveValue('Accessible bead')
    expect(screen.getByLabelText('Description')).toHaveValue('A bead with labelled fields.')
    expect(within(screen.getByRole('group', { name: 'Acceptance Criteria' })).getByRole('textbox')).toHaveValue('It can be edited.')
    expect(within(screen.getByRole('group', { name: 'Tests' })).getByRole('textbox')).toHaveValue('The fields have names.')
    expect(screen.getByRole('group', { name: 'Planned Test Commands' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Target Files' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Context Guidance — Patterns' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Context Guidance — Anti-patterns' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'PRD References' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Blocked By' })).toBeInTheDocument()
  })
})
