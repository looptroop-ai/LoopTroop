import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { startTransition, Suspense, useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_QUESTION_WINDOW_MAX_MS,
  AI_QUESTION_WINDOW_MIN_MS,
  formatAiQuestionWindow,
} from '@shared/aiQuestions'
import { InheritableDurationField } from '../InheritableDurationField'

const renderField = (
  initialValue: number | null,
  onChange = vi.fn(),
  props: Partial<ComponentProps<typeof InheritableDurationField>> = {},
) => {
  const Controlled = () => {
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

    expect(screen.getByRole('radio', { name: /Inherit ai question wait/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('5 minutes')).toBeInTheDocument()
    expect(screen.getByText(/from Project/)).toBeInTheDocument()
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
  })

  it('starts a custom override at the value that already applied', () => {
    const onChange = renderField(null, vi.fn(), { inheritedMs: 720_000 })

    fireEvent.click(screen.getByRole('radio', { name: /Set a custom ai question wait/i }))
    expect(onChange).toHaveBeenCalledWith(720_000)
    expect(screen.getByLabelText('AI question wait')).toHaveValue(12)
  })

  it('shows the value it just started the override at', () => {
    renderField(null)

    fireEvent.click(screen.getByRole('radio', { name: /Set a custom ai question wait/i }))

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
    expect(screen.getByRole('radio', { name: /Default ai question wait/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Default ai question wait/i })).toHaveAttribute('id', 'test-wait-inherit')
    expect(screen.getByText('AI question wait')).not.toHaveAttribute('for')
    expect(screen.queryByRole('radio', { name: /Inherit ai question wait/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Set a custom ai question wait/i }))
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
    fireEvent.click(screen.getByRole('radio', { name: /Set a custom ai question wait/i }))

    expect(input).toHaveValue(12)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('suppresses validation while disabled and restores the unchanged invalid text when re-enabled', () => {
    const onChange = vi.fn()
    const onValidationChange = vi.fn()
    const props = {
      label: 'AI question wait',
      idPrefix: 'test-wait',
      value: 600_000,
      onChange,
      onValidationChange,
      inheritedMs: 300_000,
      minMs: AI_QUESTION_WINDOW_MIN_MS,
      maxMs: AI_QUESTION_WINDOW_MAX_MS,
    }
    const { rerender } = render(<InheritableDurationField {...props} />)
    const input = screen.getByLabelText('AI question wait')
    fireEvent.change(input, { target: { value: '61' } })
    expect(onValidationChange).toHaveBeenLastCalledWith(true)

    rerender(<InheritableDurationField {...props} disabled disabledReason="AI questions is Off." />)
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    expect(input).toBeDisabled()
    expect(input).toHaveValue(10)
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).toHaveAttribute('aria-describedby', 'test-wait-disabled-reason')
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-describedby', 'test-wait-disabled-reason')
    expect(document.getElementById('test-wait-disabled-reason')).toHaveTextContent('AI questions is Off.')
    expect(screen.getByRole('radio', { name: /Set a custom ai question wait/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).toHaveBeenLastCalledWith(false)

    rerender(<InheritableDurationField {...props} />)
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled()
    expect(input).toBeEnabled()
    expect(input).toHaveValue(61)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Maximum is 60 minutes.')
    expect(onValidationChange).toHaveBeenLastCalledWith(true)
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

    fireEvent.click(screen.getByRole('radio', { name: /Set a custom ai question wait/i }))
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
    onValidationChange.mockClear()

    fireEvent.click(screen.getByRole('radio', { name: /Inherit ai question wait/i }))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
    expect(screen.getByText('5 minutes').parentElement).toHaveTextContent('5 minutes from Project')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).toHaveBeenLastCalledWith(false)
    expect(onValidationChange).not.toHaveBeenCalledWith(true)
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

  it.each([
    { initialValue: null, replacement: 720_000, minutes: 12 },
    { initialValue: 300_000, replacement: 900_000, minutes: 15 },
  ])('replaces the owner value with $minutes minutes without transient validation errors', ({ initialValue, replacement, minutes }) => {
    const onValidationChange = vi.fn()
    const props = {
      label: 'AI question wait',
      idPrefix: 'test-wait',
      onChange: vi.fn(),
      onValidationChange,
      inheritedMs: 300_000,
      minMs: AI_QUESTION_WINDOW_MIN_MS,
      maxMs: AI_QUESTION_WINDOW_MAX_MS,
    }
    const { rerender } = render(<InheritableDurationField {...props} value={initialValue} />)
    onValidationChange.mockClear()

    rerender(<InheritableDurationField {...props} value={replacement} />)

    expect(screen.getByLabelText('AI question wait')).toHaveValue(minutes)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onValidationChange).not.toHaveBeenCalledWith(true)
  })

  it('shows stored fractional minutes exactly and asks for whole minutes before saving', () => {
    const onValidationChange = vi.fn()
    const onChange = renderField(90_000, vi.fn(), { onValidationChange })

    expect(screen.getByLabelText('AI question wait')).toHaveValue(1.5)
    expect(screen.getByRole('alert')).toHaveTextContent('Use whole minutes (1 to 60).')
    expect(onValidationChange).toHaveBeenLastCalledWith(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('synchronizes the owner value after an interrupted render retries', async () => {
    const pending = new Promise<void>(() => {})
    const RenderGate = ({ blocked }: { blocked: boolean }) => {
      if (blocked) throw pending
      return null
    }
    const Controlled = () => {
      const [value, setValue] = useState<number | null>(300_000)
      const [blocked, setBlocked] = useState(false)
      return (
        <>
          <button onClick={() => startTransition(() => { setValue(900_000); setBlocked(true) })}>Replace wait</button>
          <button onClick={() => setBlocked(false)}>Retry render</button>
          <Suspense fallback="Waiting">
            <InheritableDurationField
              label="AI question wait" idPrefix="test-wait" value={value} onChange={setValue}
              inheritedMs={300_000} minMs={AI_QUESTION_WINDOW_MIN_MS} maxMs={AI_QUESTION_WINDOW_MAX_MS}
            />
            <RenderGate blocked={blocked} />
          </Suspense>
        </>
      )
    }
    render(<Controlled />)

    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Replace wait' })) })
    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)

    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Retry render' })) })
    expect(screen.getByLabelText('AI question wait')).toHaveValue(15)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    { commit: 'blur', finish: (input: HTMLElement) => fireEvent.blur(input) },
    { commit: 'Enter', finish: (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Enter' }) },
  ])('commits only the completed edit on $commit when commitOnBlur is enabled', ({ finish }) => {
    const onChange = renderField(300_000, vi.fn(), { commitOnBlur: true })
    const input = screen.getByLabelText('AI question wait')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.change(input, { target: { value: '30' } })
    expect(input).toHaveValue(30)
    expect(onChange).not.toHaveBeenCalled()

    finish(input)

    expect(onChange).toHaveBeenCalledExactlyOnceWith(1_800_000)
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('moves focus and switches the duration source with ArrowRight and ArrowLeft', () => {
    const onChange = renderField(null)
    const inherit = screen.getByRole('radio', { name: /Inherit ai question wait/i })
    const custom = screen.getByRole('radio', { name: /Set a custom ai question wait/i })
    inherit.focus()
    expect(inherit).toHaveAttribute('tabindex', '0')
    expect(custom).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(inherit, { key: 'ArrowRight' })

    expect(custom).toHaveFocus()
    expect(custom).toHaveAttribute('aria-checked', 'true')
    expect(custom).toHaveAttribute('tabindex', '0')
    expect(screen.getByLabelText('AI question wait')).toHaveValue(5)
    expect(onChange).toHaveBeenLastCalledWith(300_000)

    fireEvent.keyDown(custom, { key: 'ArrowLeft' })

    expect(inherit).toHaveFocus()
    expect(inherit).toHaveAttribute('aria-checked', 'true')
    expect(inherit).toHaveAttribute('tabindex', '0')
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('keeps invalid edits without committing on blur or Enter', () => {
    const onChange = renderField(300_000, vi.fn(), { commitOnBlur: true })
    const input = screen.getByLabelText('AI question wait')
    fireEvent.change(input, { target: { value: '61' } })
    fireEvent.blur(input)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue(61)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears the reported validation error when the field is actually unmounted', () => {
    const onValidationChange = vi.fn()
    const { unmount } = render(
      <InheritableDurationField
        label="AI question wait"
        idPrefix="test-wait"
        value={90_000}
        onChange={vi.fn()}
        inheritedMs={300_000}
        minMs={AI_QUESTION_WINDOW_MIN_MS}
        maxMs={AI_QUESTION_WINDOW_MAX_MS}
        onValidationChange={onValidationChange}
      />,
    )
    expect(onValidationChange).toHaveBeenLastCalledWith(true)

    unmount()

    expect(onValidationChange).toHaveBeenLastCalledWith(false)
  })
})
