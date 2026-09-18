import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptEditor, type PromptResetRequest } from '../PromptEditor'

const state = vi.hoisted(() => ({
  prompt: {
    id: 'interview',
    description: 'Interview prompt',
    kind: 'template' as string,
    modified: false,
    current: 'original: yes\n',
    default: 'original: yes\n',
  },
  saveResult: { errors: [] as string[], warnings: [] as string[] },
}))

const saveMutateAsync = vi.hoisted(() => vi.fn())
const revertMutateAsync = vi.hoisted(() => vi.fn())
const previewMutateAsync = vi.hoisted(() => vi.fn())
const previewReset = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/usePrompts', () => ({
  usePrompt: () => ({ data: state.prompt, isLoading: false, error: null }),
  useSavePrompt: () => ({ mutateAsync: saveMutateAsync, isPending: false }),
  useRevertPrompt: () => ({ mutateAsync: revertMutateAsync, isPending: false }),
  // A fresh `reset` on every render, as the real mutation hook returns.
  usePromptPreview: () => ({ mutateAsync: previewMutateAsync, reset: () => previewReset(), data: undefined, isPending: false }),
}))

// CodeMirror needs a real layout; a textarea carries the same contract for this test.
vi.mock('@/components/editor/YamlEditor', () => ({
  YamlEditor: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="Prompt source" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

vi.mock('@/components/editor/YamlDiffEditor', () => ({
  YamlDiffEditor: ({ modified, onChange }: { modified: string; onChange: (next: string) => void }) => (
    <textarea aria-label="Prompt source" value={modified} onChange={(e) => onChange(e.target.value)} />
  ),
}))

function renderEditor(onDirtyChange?: (isDirty: boolean) => void) {
  return render(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} onDirtyChange={onDirtyChange} />)
}

function renderEditorWithReset(resetRequest: PromptResetRequest | null, onDirtyChange?: (isDirty: boolean) => void) {
  return render(
    <PromptEditor
      promptId="interview"
      wordWrap={false}
      onToggleWordWrap={vi.fn()}
      onDirtyChange={onDirtyChange}
      resetRequest={resetRequest}
    />,
  )
}

/** What the server sends back after a save, which the query then republishes. */
function serverAccepts(source: string, rerender: (ui: React.ReactElement) => void) {
  state.prompt = { ...state.prompt, current: source, modified: true }
  rerender(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} />)
}

beforeEach(() => {
  state.prompt = {
    id: 'interview',
    description: 'Interview prompt',
    kind: 'template',
    modified: false,
    current: 'original: yes\n',
    default: 'original: yes\n',
  }
  state.saveResult = { errors: [], warnings: [] }
  saveMutateAsync.mockReset().mockImplementation(async () => state.saveResult)
  previewMutateAsync.mockReset().mockResolvedValue({ preview: 'assembled prompt\n' })
  revertMutateAsync.mockReset().mockResolvedValue(undefined)
  previewReset.mockReset()
})

afterEach(cleanup)

/**
 * A successful save records its warnings and a "Saved" line, then invalidates the
 * query. The server copy comes back changed, and the reset effect keyed on it wiped
 * both a few milliseconds after they appeared — so a save with warnings looked like
 * a save with nothing to say.
 */
describe('PromptEditor save feedback', () => {
  it('reports only a draft that differs from the current prompt', async () => {
    const onDirtyChange = vi.fn()
    renderEditor(onDirtyChange)

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    const source = screen.getByLabelText('Prompt source')
    fireEvent.change(source, { target: { value: 'changed: yes\n' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))

    fireEvent.change(source, { target: { value: 'original: yes\n' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('keeps the saved status and warnings when the server copy comes back', async () => {
    state.saveResult = { errors: [], warnings: ['Placeholder {{ticket}} is unused.'] }
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'changed: yes\n' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
    })
    serverAccepts('changed: yes\n', rerender)

    expect(screen.getByText('Saved. New runs will use this prompt.')).toBeInTheDocument()
    expect(screen.getByText('Placeholder {{ticket}} is unused.')).toBeInTheDocument()
  })

  it('clears the feedback on the next edit', async () => {
    state.saveResult = { errors: [], warnings: ['Placeholder {{ticket}} is unused.'] }
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'changed: yes\n' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
    })
    serverAccepts('changed: yes\n', rerender)

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'changed again\n' } })

    expect(screen.queryByText('Saved. New runs will use this prompt.')).not.toBeInTheDocument()
    expect(screen.queryByText('Placeholder {{ticket}} is unused.')).not.toBeInTheDocument()
  })

  it('keeps a dirty draft when the server copy changes underneath the editor', async () => {
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'my local draft\n' } })
    const resetsBeforeExternalUpdate = previewReset.mock.calls.length
    // Someone else — a revert, another writer — replaced the server copy.
    serverAccepts('somebody elses copy\n', rerender)

    await waitFor(() => {
      expect(screen.getByLabelText('Prompt source')).toHaveValue('my local draft\n')
    })
    expect(previewReset).toHaveBeenCalledTimes(resetsBeforeExternalUpdate)
  })

  it('resets when a different prompt is selected', async () => {
    renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'my local draft\n' } })

    state.prompt = { ...state.prompt, id: 'council', current: 'council prompt\n' }
    render(<PromptEditor promptId="council" wordWrap={false} onToggleWordWrap={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getAllByLabelText('Prompt source').at(-1)).toHaveValue('council prompt\n')
    })
  })

  it('shows a current preview failure instead of an empty preview', async () => {
    previewMutateAsync.mockRejectedValueOnce(new Error('Preview unavailable'))
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Preview unavailable'))
  })

  it('ignores a stale preview failure after a newer request starts', async () => {
    let releaseFirst: (error: Error) => void = () => undefined
    let releaseSecond: (value: { preview: string }) => void = () => undefined
    previewMutateAsync
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { releaseFirst = reject }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve }))
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'new draft\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await act(async () => { releaseFirst(new Error('stale preview failure')) })
    expect(screen.queryByText('stale preview failure')).not.toBeInTheDocument()

    await act(async () => { releaseSecond({ preview: 'current preview\n' }) })
    expect(screen.getByText(/current preview/)).toBeInTheDocument()
  })
})

/**
 * The server does not store the bytes it was sent: `savePromptTemplate` parses the
 * YAML and writes `jsYaml.dump` of the result. So the copy that comes back after a
 * save differs from the draft whenever the user's formatting differs from js-yaml's,
 * which is most of the time — a guard that compared content would have called the
 * editor's own save somebody else's edit and wiped the feedback anyway.
 */
describe('PromptEditor save feedback — canonicalized and failed saves', () => {
  it('keeps the feedback when the server returns a re-serialised copy', async () => {
    state.saveResult = { errors: [], warnings: ['Placeholder {{ticket}} is unused.'] }
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: "id:   'interview'\n" } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
    })
    // What the store wrote back is not what was sent.
    serverAccepts("id: interview\n", rerender)

    expect(screen.getByText('Saved. New runs will use this prompt.')).toBeInTheDocument()
    expect(screen.getByText('Placeholder {{ticket}} is unused.')).toBeInTheDocument()
    // and the editor now shows the canonical copy, which is what is stored
    expect(screen.getByLabelText('Prompt source')).toHaveValue('id: interview\n')
  })

  it('reports a save the server never accepted', async () => {
    saveMutateAsync.mockRejectedValue(new Error('Failed to save prompt (HTTP 503)'))
    renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'changed: yes\n' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
    })

    expect(screen.getByText('Failed to save prompt (HTTP 503)')).toBeInTheDocument()
    expect(screen.queryByText('Saved. New runs will use this prompt.')).not.toBeInTheDocument()
    // The draft is still the user's.
    expect(screen.getByLabelText('Prompt source')).toHaveValue('changed: yes\n')
  })

  it('does not report a save against a draft the user has moved on from', async () => {
    let release: (value: { errors: string[]; warnings: string[] }) => void = () => {}
    saveMutateAsync.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'first edit\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    // The editor stays editable while the request is in flight.
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'second edit\n' } })

    await act(async () => {
      release({ errors: [], warnings: [] })
    })
    // The save did happen, so its echo still arrives — and must not bring the older
    // text back over the newer one.
    serverAccepts('first edit\n', rerender)

    expect(screen.queryByText('Saved. New runs will use this prompt.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Prompt source')).toHaveValue('second edit\n')
  })

  it('keeps validation errors visible when the user types while the save is pending', async () => {
    let release: (value: { errors: string[]; warnings: string[] }) => void = () => {}
    saveMutateAsync.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'invalid: yes\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'fixed: yes\n' } })

    await act(async () => {
      release({ errors: ['Prompt source is not valid YAML.'], warnings: [] })
    })

    expect(screen.getByText('Prompt source is not valid YAML.')).toBeInTheDocument()
    expect(screen.getByLabelText('Prompt source')).toHaveValue('fixed: yes\n')
  })

  it('does not report a save against a prompt the user has switched away from', async () => {
    let release: (value: { errors: string[]; warnings: string[] }) => void = () => {}
    saveMutateAsync.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'interview edit\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    // The dialog swaps the prop; this editor is not remounted.
    state.prompt = { ...state.prompt, id: 'council', current: 'council prompt\n' }
    rerender(<PromptEditor promptId="council" wordWrap={false} onToggleWordWrap={vi.fn()} />)

    await act(async () => {
      release({ errors: [], warnings: [] })
    })

    expect(screen.queryByText('Saved. New runs will use this prompt.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Prompt source')).toHaveValue('council prompt\n')
  })

  it('keeps a dirty draft when revert fails', async () => {
    state.prompt = { ...state.prompt, current: 'saved copy\n', modified: true }
    revertMutateAsync.mockRejectedValueOnce(new Error('Failed to revert prompt (HTTP 503)'))
    renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'still editing\n' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    })

    expect(screen.getByLabelText('Prompt source')).toHaveValue('still editing\n')
    expect(screen.getByText('Failed to revert prompt (HTTP 503)')).toBeInTheDocument()
  })

  it('does not replace a later edit when successful revert settles', async () => {
    state.prompt = { ...state.prompt, current: 'saved copy\n', modified: true }
    let release: (value: { current: string }) => void = () => undefined
    revertMutateAsync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'first draft\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'later draft\n' } })
    await act(async () => {
      release({ current: 'original: yes\n' })
    })

    expect(screen.getByLabelText('Prompt source')).toHaveValue('later draft\n')
  })

  it('applies reset-all server state only when no later edit exists', async () => {
    state.prompt = { ...state.prompt, current: 'saved copy\n', modified: true }
    const { rerender } = renderEditorWithReset(null)

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'first draft\n' } })
    rerender(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} resetRequest={{ id: 1, status: 'pending' }} />)
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'later draft\n' } })

    state.prompt = { ...state.prompt, current: 'original: yes\n', modified: false }
    rerender(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} resetRequest={{ id: 1, status: 'success' }} />)

    expect(screen.getByLabelText('Prompt source')).toHaveValue('later draft\n')
  })

  it('preserves the draft when reset-all fails', async () => {
    state.prompt = { ...state.prompt, current: 'saved copy\n', modified: true }
    const { rerender } = renderEditorWithReset(null)

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'still editing\n' } })
    rerender(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} resetRequest={{ id: 2, status: 'pending' }} />)
    rerender(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} resetRequest={{ id: 2, status: 'failure' }} />)

    expect(screen.getByLabelText('Prompt source')).toHaveValue('still editing\n')
  })
})
