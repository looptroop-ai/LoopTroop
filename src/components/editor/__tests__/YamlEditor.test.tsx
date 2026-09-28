import { act, render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { YamlEditor } from '../YamlEditor'

function editorFrom(container: HTMLElement): EditorView {
  const content = container.querySelector<HTMLElement>('.cm-content')
  expect(content).not.toBeNull()
  const editor = EditorView.findFromDOM(content!)
  expect(editor).not.toBeNull()
  return editor!
}

describe('YamlEditor', () => {
  it('notifies the current callback when the document changes', () => {
    const initialOnChange = vi.fn()
    const latestOnChange = vi.fn()
    const view = render(<YamlEditor value="name: first" onChange={initialOnChange} className="yaml-test-editor" />)
    const editor = editorFrom(view.container)

    expect(editor.state.doc.toString()).toBe('name: first')
    expect(view.container.firstElementChild).toHaveClass('yaml-test-editor')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'name: edited' } }))
    expect(initialOnChange).toHaveBeenCalledWith('name: edited')

    view.rerender(<YamlEditor value="name: edited" onChange={latestOnChange} />)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'name: latest' } }))
    expect(latestOnChange).toHaveBeenCalledWith('name: latest')
    expect(initialOnChange).toHaveBeenCalledTimes(1)
  })

  it('syncs an external value and updates read-only and wrapping settings', () => {
    const view = render(<YamlEditor value="name: local" onChange={vi.fn()} />)
    const editor = editorFrom(view.container)

    expect(editor.state.facet(EditorState.readOnly)).toBe(false)
    expect(editor.contentDOM).not.toHaveClass('cm-lineWrapping')

    view.rerender(<YamlEditor value="name: server" onChange={vi.fn()} readOnly wordWrap />)
    expect(editor.state.doc.toString()).toBe('name: server')
    expect(editor.state.facet(EditorState.readOnly)).toBe(true)
    expect(editor.contentDOM).toHaveClass('cm-lineWrapping')

    view.rerender(<YamlEditor value="name: server" onChange={vi.fn()} />)
    expect(editor.state.facet(EditorState.readOnly)).toBe(false)
    expect(editor.contentDOM).not.toHaveClass('cm-lineWrapping')

    view.unmount()
    expect(view.container).not.toContainElement(editor.dom)
  })

  it('starts read-only with wrapping enabled when those options are initially set', () => {
    const view = render(<YamlEditor value="name: initial" onChange={vi.fn()} readOnly wordWrap />)
    const editor = editorFrom(view.container)

    expect(editor.state.facet(EditorState.readOnly)).toBe(true)
    expect(editor.contentDOM).toHaveClass('cm-lineWrapping')
  })
})
