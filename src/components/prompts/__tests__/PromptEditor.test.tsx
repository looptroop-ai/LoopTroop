import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptEditor } from '../PromptEditor'

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
const previewReset = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/usePrompts', () => ({
  usePrompt: () => ({ data: state.prompt, isLoading: false, error: null }),
  useSavePrompt: () => ({ mutateAsync: saveMutateAsync, isPending: false }),
  useRevertPrompt: () => ({ mutateAsync: revertMutateAsync, isPending: false }),
  // A fresh `reset` on every render, as the real mutation hook returns.
  usePromptPreview: () => ({ mutateAsync: vi.fn(), reset: () => previewReset(), data: undefined, isPending: false }),
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

function renderEditor() {
  return render(<PromptEditor promptId="interview" wordWrap={false} onToggleWordWrap={vi.fn()} />)
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

  it('still resets everything when the server copy changes underneath the editor', async () => {
    const { rerender } = renderEditor()

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'my local draft\n' } })
    // Someone else — a revert, another writer — replaced the server copy.
    serverAccepts('somebody elses copy\n', rerender)

    await waitFor(() => {
      expect(screen.getByLabelText('Prompt source')).toHaveValue('somebody elses copy\n')
    })
    expect(previewReset).toHaveBeenCalled()
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
})
