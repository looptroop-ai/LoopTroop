import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildPrdApprovalDraft, type PrdApprovalDraft } from '@/lib/prdDocument'
import { makePrdDocument } from '@/test/factories'
import { PrdApprovalEditor } from '../PrdApprovalEditor'

function listEditor(container: HTMLElement, label: string) {
  const labelElement = within(container).getByText(label, { exact: true })
  const section = labelElement.closest('div.rounded-xl')
  expect(section).not.toBeNull()
  return within(section!)
}

function ControlledEditor({
  initialDraft,
  onChange,
  disabled = false,
}: {
  initialDraft: PrdApprovalDraft
  onChange: (draft: PrdApprovalDraft) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <PrdApprovalEditor
      draft={draft}
      disabled={disabled}
      onChange={(nextDraft) => {
        onChange(nextDraft)
        setDraft(nextDraft)
      }}
    />
  )
}

describe('PrdApprovalEditor', () => {
  it('edits problem details and adds an epic and a user story to an empty draft', () => {
    const onChange = vi.fn()
    const draft = buildPrdApprovalDraft(makePrdDocument({ epics: [] }))
    render(<ControlledEditor initialDraft={draft} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Problem Statement'), { target: { value: 'Make setup reliable.' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      product: expect.objectContaining({ problem_statement: 'Make setup reliable.' }),
    }))
    expect(screen.getByText('No epics recorded yet.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add Epic' }))
    expect(screen.getByRole('button', { name: /EPIC-1 Untitled epic 0 stories/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: /EPIC-1 Untitled epic 0 stories/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add User Story' }))

    expect(screen.getByRole('button', { name: /EPIC-1 Untitled epic 1 story/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByDisplayValue('US-1-1')).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({
        id: 'EPIC-1',
        user_stories: [expect.objectContaining({ id: 'US-1-1', verification: { required_commands: [] } })],
      })],
    }))
  })

  it('edits and reorders stories while keeping epic and story fields in the draft', () => {
    const onChange = vi.fn()
    const draft = buildPrdApprovalDraft(makePrdDocument())
    render(<ControlledEditor initialDraft={draft} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /EPIC-A Test epic 1 story/ }))
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship the feature.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add User Story' }))

    fireEvent.change(screen.getByDisplayValue('US-1-2'), { target: { value: 'US-A2' } })
    const newStory = screen.getByText('Untitled user story').closest('article')!
    fireEvent.change(within(newStory).getByLabelText('Title'), { target: { value: 'Add a clear flow' } })
    fireEvent.click(within(screen.getByText('Add a clear flow').closest('article')!).getByRole('button', { name: 'Move Up' }))

    expect(screen.getByRole('button', { name: /EPIC-A Test epic 2 stories/ })).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({
        objective: 'Ship the feature.',
        user_stories: [
          expect.objectContaining({ id: 'US-A2', title: 'Add a clear flow' }),
          expect.objectContaining({ id: 'US-A1', title: 'As a user, I can perform the test action.' }),
        ],
      })],
    }))

    const reorderedStory = screen.getByText('Add a clear flow').closest('article')!
    fireEvent.click(within(reorderedStory).getByRole('button', { name: 'Move Down' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({
        user_stories: [
          expect.objectContaining({ id: 'US-A1' }),
          expect.objectContaining({ id: 'US-A2', title: 'Add a clear flow' }),
        ],
      })],
    }))

    fireEvent.click(within(screen.getByText('Add a clear flow').closest('article')!).getByRole('button', { name: 'Remove' }))
    expect(screen.queryByText('Add a clear flow')).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({ user_stories: [expect.objectContaining({ id: 'US-A1' })] })],
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Add Epic' }))
    const secondEpicTrigger = screen.getByRole('button', { name: /EPIC-2 Untitled epic 0 stories/ })
    fireEvent.click(secondEpicTrigger)
    fireEvent.change(within(secondEpicTrigger.closest('div.border')!).getByLabelText('Epic ID'), { target: { value: 'EPIC-B' } })
    const updatedEpicTrigger = screen.getByRole('button', { name: /EPIC-B Untitled epic 0 stories/ })
    fireEvent.click(updatedEpicTrigger)
    fireEvent.change(within(updatedEpicTrigger.closest('div.border')!).getByLabelText('Title'), { target: { value: 'Second epic' } })
    const namedEpicTrigger = screen.getByRole('button', { name: /EPIC-B Second epic 0 stories/ })
    fireEvent.change(within(namedEpicTrigger.closest('div.border')!).getByLabelText('Epic ID'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: /EPIC-2 Second epic 0 stories/ })).toBeInTheDocument()

    const firstEpicTrigger = screen.getByRole('button', { name: /EPIC-A Test epic 1 story/ })
    fireEvent.click(within(firstEpicTrigger.closest('div.border')!).getAllByRole('button', { name: 'Move Down' })[0]!)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({ id: '' }), expect.objectContaining({ id: 'EPIC-A' })],
    }))
    const movedEpicTrigger = screen.getByRole('button', { name: /EPIC-A Test epic 1 story/ })
    fireEvent.click(movedEpicTrigger)
    fireEvent.click(within(movedEpicTrigger.closest('div.border')!).getAllByRole('button', { name: 'Move Up' })[0]!)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({ id: 'EPIC-A' }), expect.objectContaining({ id: '' })],
    }))

    const removableEpicTrigger = screen.getByRole('button', { name: /EPIC-2 Second epic 0 stories/ })
    fireEvent.click(removableEpicTrigger)
    fireEvent.click(within(removableEpicTrigger.closest('div.border')!).getByRole('button', { name: 'Remove Epic' }))
    expect(screen.queryByText('Second epic')).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ epics: [expect.objectContaining({ id: 'EPIC-A' })] }))
  })

  it('updates scope, requirement, epic-step, story criteria, and verification lists', () => {
    const onChange = vi.fn()
    const draft = buildPrdApprovalDraft(makePrdDocument())
    render(<ControlledEditor initialDraft={draft} onChange={onChange} />)

    const targetUsers = listEditor(document.body, 'Target Users')
    fireEvent.click(targetUsers.getByRole('button', { name: 'Add User' }))
    fireEvent.change(targetUsers.getAllByRole('textbox')[1]!, { target: { value: 'Administrators' } })
    fireEvent.click(targetUsers.getAllByRole('button', { name: '↑' })[1]!)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      product: expect.objectContaining({ target_users: ['Administrators', 'Operators'] }),
    }))
    fireEvent.click(targetUsers.getAllByRole('button', { name: '↓' })[0]!)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      product: expect.objectContaining({ target_users: ['Operators', 'Administrators'] }),
    }))
    fireEvent.click(targetUsers.getAllByRole('button', { name: '↑' })[1]!)
    fireEvent.click(targetUsers.getAllByRole('button', { name: '×' })[1]!)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      product: expect.objectContaining({ target_users: ['Administrators'] }),
    }))

    for (const [label, button, field] of [
      ['Risks', 'Add Risk', 'risks'],
      ['In Scope', 'Add Scope Item', 'in_scope'],
      ['Out Of Scope', 'Add Exclusion', 'out_of_scope'],
    ] as const) {
      fireEvent.click(listEditor(document.body, label).getByRole('button', { name: button }))
      const nextDraft = onChange.mock.lastCall?.[0] as PrdApprovalDraft
      if (field === 'risks') expect(nextDraft.risks).toEqual([''])
      if (field === 'in_scope') expect(nextDraft.scope.in_scope).toEqual(['Test scope item', ''])
      if (field === 'out_of_scope') expect(nextDraft.scope.out_of_scope).toEqual(['Out of scope item', ''])
    }

    fireEvent.click(listEditor(document.body, 'API Contracts').getByRole('button', { name: 'Add Entry' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      technical_requirements: expect.objectContaining({ api_contracts: [''] }),
    }))

    const epicTrigger = screen.getByRole('button', { name: /EPIC-A Test epic 1 story/ })
    fireEvent.click(epicTrigger)
    const epicSection = epicTrigger.closest('div.border')!
    const epicSteps = listEditor(epicSection, 'Epic Implementation Steps')
    fireEvent.click(epicSteps.getByRole('button', { name: 'Add Step' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({ implementation_steps: ['Add test step', ''] })],
    }))

    const story = screen.getByText('As a user, I can perform the test action.').closest('article')!
    fireEvent.click(listEditor(story, 'Acceptance Criteria').getByRole('button', { name: 'Add Criterion' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({
        user_stories: [expect.objectContaining({ acceptance_criteria: ['Test criterion is met.', ''] })],
      })],
    }))
    fireEvent.click(listEditor(story, 'Implementation Steps').getByRole('button', { name: 'Add Step' }))
    fireEvent.click(within(story).getByRole('button', { name: 'Add command' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      epics: [expect.objectContaining({
        user_stories: [expect.objectContaining({
          verification: { required_commands: [...draft.epics[0]!.user_stories[0]!.verification.required_commands, {
            mode: 'process', program: '', args: [], cwd: '.', env: {},
          }] },
        })],
      })],
    }))
  })

  it('disables edits when the draft is read-only', () => {
    const draft = buildPrdApprovalDraft(makePrdDocument())
    render(<ControlledEditor initialDraft={draft} onChange={vi.fn()} disabled />)

    expect(screen.getByLabelText('Problem Statement')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add Epic' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /EPIC-A Test epic 1 story/ }))
    expect(screen.getByLabelText('Objective')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add User Story' })).toBeDisabled()
  })
})
