import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { yamlEditorFullHeightTheme, yamlEditorTheme } from '../yamlEditorTheme'

/**
 * Both YAML editors used to carry their own copy of these declarations, so a
 * change to one made the two look different with nothing to say so. The theme
 * is now one module, and this is what holds the extraction to visual parity:
 * every declaration the two panes shared is still in the shared theme, and the
 * two the single-document editor adds are still only in its own.
 *
 * CodeMirror injects its themes as real stylesheet rules, so the assertions are
 * against the CSS that reaches the document rather than against the object that
 * produced it. CodeMirror's own base theme also declares `height: 100%` and
 * `.cm-activeLineGutter`, so what is measured is the rules a given extension
 * *adds* — otherwise the negative assertions below would be about the base
 * theme rather than about ours.
 */
function allInjectedCss(): string {
  return [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n')
}

function mount(extensions: readonly unknown[]): void {
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({
    state: EditorState.create({ doc: 'key: value', extensions: extensions as never }),
    parent: host,
  })
  view.destroy()
  host.remove()
}

/**
 * Rough chunks, one per `}`. Nested at-rules split into fragments, which is
 * fine: the same fragments appear on both sides of the difference below and
 * cancel out. A set difference rather than a string slice, because CodeMirror's
 * style module inserts by priority rather than appending.
 */
function cssChunks(css: string): string[] {
  return css.split('}').map((chunk) => `${chunk}}`.replace(/\s+/g, ' ').trim()).filter((chunk) => chunk !== '}')
}

function cssAddedBy(extensions: readonly unknown[]): string {
  const before = new Set(cssChunks(allInjectedCss()))
  mount(extensions)
  const added = cssChunks(allInjectedCss()).filter((chunk) => !before.has(chunk))
  // An empty difference would make every assertion below vacuous.
  expect(added.length).toBeGreaterThan(0)
  return added.join(' ')
}

// Puts CodeMirror's base theme in the document before anything is measured, so
// it lands in the baseline instead of in the first extension's diff.
mount([])

describe('yamlEditorTheme', () => {
  const shared = cssAddedBy([yamlEditorTheme])
  const fullHeight = cssAddedBy([yamlEditorFullHeightTheme])

  it.each([
    ['the 12px type scale', 'font-size: 12px'],
    ['the transparent ground the surrounding card shows through', 'background-color: transparent'],
    ['the themed foreground', 'color: var(--color-foreground)'],
    ['a scrolling viewport', 'overflow: auto'],
    ['the monospace stack', 'font-family: var(--font-mono, ui-monospace, monospace)'],
    ['the themed gutter', 'background-color: var(--color-muted)'],
    ['the gutter separator', 'border-right: 1px solid var(--color-border)'],
    ['the active-line tint', 'background-color: var(--color-accent)'],
    ['the brand selection colour', 'background-color: var(--color-brand-500)'],
  ])('keeps %s', (_label, declaration) => {
    expect(shared).toContain(declaration)
  })

  /**
   * The diff editor sizes itself from its two panes and renders no active-line
   * gutter, so these two belong to the single-document editor alone. In the
   * shared theme they would reach the diff editor by accident.
   */
  it('leaves the single-document extras out of the shared theme', () => {
    expect(shared).not.toContain('height: 100%')
    expect(shared).not.toContain('cm-activeLineGutter')
  })

  it('carries those extras in the full-height theme instead', () => {
    expect(fullHeight).toContain('height: 100%')
    expect(fullHeight).toContain('cm-activeLineGutter')
  })
})
