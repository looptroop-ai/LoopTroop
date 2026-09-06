import { useRef, useEffect, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { yaml } from '@codemirror/lang-yaml'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { yamlEditorFullHeightTheme, yamlEditorTheme } from './yamlEditorTheme'

interface YamlEditorProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  wordWrap?: boolean
  className?: string
}

export function YamlEditor({ value, onChange, readOnly = false, wordWrap = false, className }: YamlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const initialValueRef = useRef(value)
  const initialReadOnlyRef = useRef(readOnly)
  const initialWordWrapRef = useRef(wordWrap)
  const onChangeRef = useRef(onChange)
  const readOnlyCompartmentRef = useRef(new Compartment())
  const wordWrapCompartmentRef = useRef(new Compartment())
  onChangeRef.current = onChange

  const createState = useCallback((doc: string) => {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle),
        yaml(),
        keymap.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        readOnlyCompartmentRef.current.of(EditorState.readOnly.of(initialReadOnlyRef.current)),
        wordWrapCompartmentRef.current.of(initialWordWrapRef.current ? EditorView.lineWrapping : []),
        yamlEditorTheme,
        yamlEditorFullHeightTheme,
      ],
    })
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const view = new EditorView({
      state: createState(initialValueRef.current),
      parent: containerRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [createState])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wordWrapCompartmentRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap])

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }
  }, [value])

  return <div ref={containerRef} className={className} />
}
