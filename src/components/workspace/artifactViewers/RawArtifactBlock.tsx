/**
 * The raw-artifact fallback the approval panes show when there is no structured
 * document to render: the artifact's text, or a sentence saying there is none.
 *
 * Four sites wrote out the same `content ? <box><pre/></box> : <empty>` ternary
 * with only the empty sentence differing.
 */
export function RawArtifactBlock({ content, emptyLabel }: { content: string; emptyLabel: string }) {
  if (!content) {
    return <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">{emptyLabel}</div>
  }

  return (
    <div className="raw-content-box">
      <pre className="raw-content-pre">{content}</pre>
    </div>
  )
}
