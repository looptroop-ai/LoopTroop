import { act, render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YamlDiffEditor } from '../YamlDiffEditor'

function editorFrom(container: HTMLElement, side: 'a' | 'b'): EditorView {
  const content = container.querySelector<HTMLElement>(`.cm-merge-${side} .cm-content`)
  expect(content).not.toBeNull()
  const editor = EditorView.findFromDOM(content!)
  expect(editor).not.toBeNull()
  return editor!
}

afterEach(() => vi.restoreAllMocks())

describe('YamlDiffEditor', () => {
  it('keeps the reference read-only and sends only edited document changes to the latest callback', () => {
    const initialOnChange = vi.fn()
    const latestOnChange = vi.fn()
    const rendered = render(
      <YamlDiffEditor
        original="name: default"
        modified="name: custom"
        onChange={initialOnChange}
        wordWrap
        className="yaml-diff-test"
      />,
    )
    const original = editorFrom(rendered.container, 'a')
    const modified = editorFrom(rendered.container, 'b')

    expect(rendered.container.firstElementChild).toHaveClass('yaml-diff-test')
    expect(original.state.doc.toString()).toBe('name: default')
    expect(modified.state.doc.toString()).toBe('name: custom')
    expect(original.state.facet(EditorState.readOnly)).toBe(true)
    expect(modified.state.facet(EditorState.readOnly)).toBe(false)
    expect(original.contentDOM).toHaveClass('cm-lineWrapping')
    expect(modified.contentDOM).toHaveClass('cm-lineWrapping')

    act(() => modified.dispatch({ selection: { anchor: 0 } }))
    expect(initialOnChange).not.toHaveBeenCalled()

    act(() => modified.dispatch({ changes: { from: 0, to: modified.state.doc.length, insert: 'name: edited' } }))
    expect(initialOnChange).toHaveBeenCalledTimes(1)
    expect(initialOnChange).toHaveBeenCalledWith('name: edited')

    rendered.rerender(
      <YamlDiffEditor
        original="name: default"
        modified="name: edited"
        onChange={latestOnChange}
        wordWrap
      />,
    )
    act(() => modified.dispatch({ changes: { from: 0, to: modified.state.doc.length, insert: 'name: latest' } }))

    expect(latestOnChange).toHaveBeenCalledWith('name: latest')
    expect(initialOnChange).toHaveBeenCalledTimes(1)
  })

  it('syncs external document updates and toggles wrapping on both panes', () => {
    const rendered = render(
      <YamlDiffEditor original="name: default" modified="name: local" onChange={vi.fn()} />,
    )
    const original = editorFrom(rendered.container, 'a')
    const modified = editorFrom(rendered.container, 'b')

    expect(original.contentDOM).not.toHaveClass('cm-lineWrapping')
    expect(modified.contentDOM).not.toHaveClass('cm-lineWrapping')

    rendered.rerender(
      <YamlDiffEditor
        original="name: selected default"
        modified="name: restored version"
        onChange={vi.fn()}
        wordWrap
      />,
    )

    expect(original.state.doc.toString()).toBe('name: selected default')
    expect(modified.state.doc.toString()).toBe('name: restored version')
    expect(original.contentDOM).toHaveClass('cm-lineWrapping')
    expect(modified.contentDOM).toHaveClass('cm-lineWrapping')

    rendered.rerender(
      <YamlDiffEditor
        original="name: selected default"
        modified="name: restored version"
        onChange={vi.fn()}
      />,
    )

    expect(original.contentDOM).not.toHaveClass('cm-lineWrapping')
    expect(modified.contentDOM).not.toHaveClass('cm-lineWrapping')
  })

  it('destroys both merge panes when unmounted', () => {
    const destroy = vi.spyOn(MergeView.prototype, 'destroy')
    const rendered = render(<YamlDiffEditor original="old: value" modified="new: value" onChange={vi.fn()} />)

    rendered.unmount()

    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
