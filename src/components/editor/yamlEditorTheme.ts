import { EditorView } from '@codemirror/view'

/**
 * The CodeMirror look shared by the YAML editor and the YAML diff editor.
 *
 * Both panes are the same editor to a reader — same 12px monospace, same
 * transparent ground so the surrounding card shows through, same gutter and
 * selection colours — and both maintained their own copy of it, so a change to
 * one silently made the two look different.
 *
 * Every value is a CSS variable rather than a colour, which is what makes the
 * editors follow the app's light and dark themes without a second definition.
 *
 * Deliberately not Tailwind utilities: CodeMirror renders its own DOM
 * (`.cm-scroller`, `.cm-gutters`, `.cm-activeLine`) that no class of ours
 * reaches.
 */
export const yamlEditorTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'transparent', color: 'var(--color-foreground)' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', caretColor: 'var(--color-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--color-muted)', color: 'var(--color-muted-foreground)', borderRight: '1px solid var(--color-border)' },
  '.cm-activeLine': { backgroundColor: 'var(--color-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--color-brand-500)', opacity: '0.3' },
})

/**
 * What the single-document editor adds on top.
 *
 * It fills its container, where the diff editor sizes itself from its two
 * panes; and it highlights the active line's gutter, which the diff editor does
 * not render. Kept apart rather than merged into the shared theme so that
 * neither difference is one the other editor picks up by accident.
 */
export const yamlEditorFullHeightTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-accent)' },
})
