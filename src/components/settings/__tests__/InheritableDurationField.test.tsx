import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_QUESTION_WINDOW_MAX_MS,
  AI_QUESTION_WINDOW_MIN_MS,
  formatAiQuestionWindow,
} from '@shared/aiQuestions'
import { InheritableDurationField } from '../InheritableDurationField'

function renderField(value: number | null, onChange = vi.fn()) {
  render(
    <InheritableDurationField
      label="AI question wait"
      idPrefix="test-wait"
      value={value}
      onChange={onChange}
      inheritedMs={300_000}
      inheritedSourceLabel="Project"
      minMs={AI_QUESTION_WINDOW_MIN_MS}
      maxMs={AI_QUESTION_WINDOW_MAX_MS}
      hint="Waiting does not use up the step's working time."
      formatValue={formatAiQuestionWindow}
    />,
  )
  return onChange
}

describe('InheritableDurationField', () => {
  afterEach(cleanup)

  it('reads out the inherited duration and its source while inheriting', () => {
    renderField(null)

    expect(screen.getByRole('radio', { name: 'Inherit ai question wait' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('5 minutes')).toBeInTheDocument()
    expect(screen.getByText(/from Project/)).toBeInTheDocument()
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
  })

  it('starts a custom override at the value that already applied', () => {
    const onChange = renderField(null)

    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(onChange).toHaveBeenCalledWith(300_000)
  })

  it('shows the value it just started the override at', () => {
    // A controlled owner, which is how every real caller uses this. Asserting
    // only that `onChange` fired missed the whole defect: the box stayed empty
    // and reported "enter a number of minutes" while a valid override was
    // already saved, because the resync effect skips a value this component
    // emitted itself.
    function Controlled() {
      const [value, setValue] = useState<number | null>(null)
      return (
        <InheritableDurationField
          label="AI question wait"
          idPrefix="test-wait"
          value={value}
          onChange={setValue}
          inheritedMs={300_000}
          minMs={AI_QUESTION_WINDOW_MIN_MS}
          maxMs={AI_QUESTION_WINDOW_MAX_MS}
          formatValue={formatAiQuestionWindow}
        />
      )
    }
    render(<Controlled />)

    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))

    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)
    expect(screen.queryByText(/Enter a number of minutes/)).not.toBeInTheDocument()
  })

  it('emits milliseconds for an in-range edit', () => {
    const onChange = renderField(300_000)

    const input = screen.getByLabelText('AI question wait')
    expect(input).toHaveValue(5)

    fireEvent.change(input, { target: { value: '12' } })
    expect(onChange).toHaveBeenCalledWith(720_000)
  })

  it('explains an out-of-range edit without emitting it', () => {
    const onChange = renderField(300_000)
    const input = screen.getByLabelText('AI question wait')

    fireEvent.change(input, { target: { value: '61' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Maximum is 60 minutes.')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '0' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum is 1 minute.')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number of minutes (1–60).')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('describes the input with its hint and, once invalid, its error', () => {
    renderField(300_000)
    const input = screen.getByLabelText('AI question wait')

    expect(input).toHaveAttribute('aria-describedby', 'test-wait-hint')
    expect(document.getElementById('test-wait-hint')).toHaveTextContent(
      "Waiting does not use up the step's working time.",
    )

    fireEvent.change(input, { target: { value: '99' } })
    expect(input).toHaveAttribute('aria-describedby', 'test-wait-hint test-wait-error')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('returns to inheriting from the clear affordance', () => {
    const onChange = renderField(600_000)

    fireEvent.click(screen.getByRole('button', { name: 'Clear override' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('resyncs the input when the owner replaces the value', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={300_000}
        onChange={onChange}
        inheritedMs={300_000}
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
      />,
    )
    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)

    rerender(
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={1_800_000}
        onChange={onChange}
        inheritedMs={300_000}
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
      />,
    )
    expect(screen.getByLabelText('AI question wait')).toHaveValue(30)
  })
})
