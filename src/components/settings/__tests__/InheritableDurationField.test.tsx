import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_QUESTION_WINDOW_MAX_MS,
  AI_QUESTION_WINDOW_MIN_MS,
  formatAiQuestionWindow,
} from '@shared/aiQuestions'
import { InheritableDurationField } from '../InheritableDurationField'

function renderField(
  initialValue: number | null,
  onChange = vi.fn(),
  props: Partial<ComponentProps<typeof InheritableDurationField>> = {},
) {
  function Controlled() {
    const [value, setValue] = useState(initialValue)
    return (
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
        inheritedMs={300_000}
        inheritedSourceLabel="Project"
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
        hint="Waiting does not use up the step's working time."
        formatValue={formatAiQuestionWindow}
        {...props}
      />
    )
  }
  render(<Controlled />)
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
    const onChange = renderField(null, vi.fn(), { inheritedMs: 720_000 })

    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(onChange).toHaveBeenCalledWith(720_000)
    expect(screen.getByLabelText('AI question wait')).toHaveValue(12)
  })

  it('shows the value it just started the override at', () => {
    renderField(null)

    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))

    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)
    expect(screen.queryByText(/Enter a number of minutes/)).not.toBeInTheDocument()
  })

  it('renders optional help beside the label and can name inheritance Default', () => {
    renderField(null, vi.fn(), {
      inheritLabel: 'Default',
      help: <a href="/configuration#ai-question-wait">Wait help</a>,
    })

    expect(screen.getByText('AI question wait').parentElement).toContainElement(
      screen.getByRole('link', { name: 'Wait help' }),
    )
    expect(screen.getByRole('radio', { name: 'Default ai question wait' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radio', { name: 'Inherit ai question wait' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)
  })

  it.each([1, 12, 60])('emits milliseconds for an in-range edit of %i minutes', (minutes) => {
    const onChange = renderField(300_000)

    const input = screen.getByLabelText('AI question wait')
    expect(input).toHaveValue(5)

    fireEvent.change(input, { target: { value: String(minutes) } })
    expect(onChange).toHaveBeenCalledWith(minutes * 60_000)
    expect(input).toHaveValue(minutes)
  })

  it('preserves an edited custom value when Custom is already selected', () => {
    const onChange = renderField(600_000)
    const input = screen.getByLabelText('AI question wait')

    fireEvent.change(input, { target: { value: '12' } })
    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))

    expect(input).toHaveValue(12)
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([
    ['61', 'Maximum is 60 minutes.'],
    ['0', 'Minimum is 1 minute.'],
    ['', 'Enter a number of minutes (1 to 60).'],
    ['2.5', 'Use whole minutes (1 to 60).'],
  ])('keeps invalid minutes %j visible, reports validation, and never emits them', (raw, error) => {
    const onValidationChange = vi.fn()
    const onChange = renderField(300_000, vi.fn(), { onValidationChange })
    const input = screen.getByLabelText('AI question wait')
    expect(onValidationChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(input, { target: { value: raw } })
    expect(input).toHaveValue(raw === '' ? null : Number(raw))
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(onValidationChange).toHaveBeenLastCalledWith(true)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(input).toHaveValue(raw === '' ? null : Number(raw))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '12' } })
    expect(onChange).toHaveBeenCalledWith(720_000)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).toHaveBeenLastCalledWith(false)
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

  it('returns to inheritance through its radio and clears validation', () => {
    const onValidationChange = vi.fn()
    const onChange = renderField(600_000, vi.fn(), { onValidationChange })

    expect(screen.queryByRole('button', { name: 'Clear override' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('AI question wait'), { target: { value: '61' } })
    expect(onValidationChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Inherit ai question wait' }))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
    expect(screen.getByText('5 minutes').parentElement).toHaveTextContent('5 minutes from Project')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).toHaveBeenLastCalledWith(false)
  })

  it('resyncs the input when the owner replaces the value', () => {
    const onChange = vi.fn()
    const onValidationChange = vi.fn()
    const { rerender } = render(
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={300_000}
        onChange={onChange}
        onValidationChange={onValidationChange}
        inheritedMs={300_000}
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
      />,
    )
    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)
    fireEvent.change(screen.getByLabelText('AI question wait'), { target: { value: '61' } })
    expect(onValidationChange).toHaveBeenLastCalledWith(true)

    rerender(
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={1_800_000}
        onChange={onChange}
        onValidationChange={onValidationChange}
        inheritedMs={300_000}
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
      />,
    )
    expect(screen.getByLabelText('AI question wait')).toHaveValue(30)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).toHaveBeenLastCalledWith(false)
  })
})
