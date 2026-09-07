import { useEffect, useRef } from 'react'
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { MergeView } from '@codemirror/merge'
import { yaml } from '@codemirror/lang-yaml'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { yamlEditorTheme } from './yamlEditorTheme'

interface YamlDiffEditorProps {
  /** Left pane: the read-only reference document (the built-in default). */
  original: string
  /** Right pane: the user's editable version. */
  modified: string
  onChange: (value: string) => void
  wordWrap?: boolean
  className?: string
}

/**
 * The default merge styling only underlines changed text, which reads as noise
 * next to YAML syntax highlighting. These themes replace it with a tinted line
 * background plus a stronger tint on the exact changed span: red on the
 * reference pane (text that is absent from your version) and green on the
 * editable pane (text you added or altered). Alphas are kept low so the
 * syntax colors underneath stay legible in both light and dark themes.
 */
function diffTheme(rgb: string) {
  return EditorView.theme({
    '.cm-changedLine': { backgroundColor: `rgba(${rgb}, 0.10)` },
    '.cm-changedText': {
      // Override the built-in underline gradient.
      background: `rgba(${rgb}, 0.28)`,
      borderRadius: '2px',
    },
    '.cm-changedLine .cm-changedText': { background: `rgba(${rgb}, 0.28)` },
    '.cm-deletedChunk': { backgroundColor: 'rgba(220, 38, 38, 0.10)' },
    '.cm-deletedChunk .cm-deletedText': { background: 'rgba(220, 38, 38, 0.28)' },
    '.cm-changeGutter': { backgroundColor: `rgba(${rgb}, 0.18)` },
  })
}

const DELETION_RGB = '220, 38, 38'
const INSERTION_RGB = '22, 163, 74'

function baseExtensions() {
  return [
    lineNumbers(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(defaultHighlightStyle),
    yaml(),
    yamlEditorTheme,
  ]
}

/**
 * Side-by-side diff of the built-in default (left, read-only) against the
 * user's version (right, editable). Edits on the right stream out through
 * `onChange` and the diff highlighting re-computes live as you type.
 */
export function YamlDiffEditor({ original, modified, onChange, wordWrap = false, className }: YamlDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mergeViewRef = useRef<MergeView | null>(null)
  const wrapCompartmentRef = useRef(new Compartment())

  const initialOriginalRef = useRef(original)
  const initialModifiedRef = useRef(modified)
  const initialWrapRef = useRef(wordWrap)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return

    const wrapExt = wrapCompartmentRef.current.of(initialWrapRef.current ? EditorView.lineWrapping : [])

    const view = new MergeView({
      parent: containerRef.current,
      a: {
        doc: initialOriginalRef.current,
        extensions: [...baseExtensions(), diffTheme(DELETION_RGB), EditorState.readOnly.of(true), wrapExt],
      },
      b: {
        doc: initialModifiedRef.current,
        extensions: [
          ...baseExtensions(),
          diffTheme(INSERTION_RGB),
          wrapExt,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      },
      gutter: true,
      highlightChanges: true,
    })
    mergeViewRef.current = view

    return () => {
      view.destroy()
      mergeViewRef.current = null
    }
  }, [])

  // Toggle wrapping on both panes without rebuilding the view.
  useEffect(() => {
    const view = mergeViewRef.current
    if (!view) return
    const effects = wrapCompartmentRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : [])
    view.a.dispatch({ effects })
    view.b.dispatch({ effects })
  }, [wordWrap])

  // Sync the reference document when a different prompt is selected.
  useEffect(() => {
    const view = mergeViewRef.current
    if (!view) return
    const current = view.a.state.doc.toString()
    if (current !== original) {
      view.a.dispatch({ changes: { from: 0, to: current.length, insert: original } })
    }
  }, [original])

  // Sync the editable document when it is changed from outside (e.g. revert).
  useEffect(() => {
    const view = mergeViewRef.current
    if (!view) return
    const current = view.b.state.doc.toString()
    if (current !== modified) {
      view.b.dispatch({ changes: { from: 0, to: current.length, insert: modified } })
    }
  }, [modified])

  return <div ref={containerRef} className={className} />
}
