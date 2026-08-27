import type { ReactNode } from 'react'

/**
 * Renders the subset of Markdown that GitHub release bodies for this project
 * actually contain: headings, bullet lists, fenced code, bold, inline code and
 * links.
 *
 * Deliberately not a Markdown library. The notes are generated from
 * `CHANGELOG.md` by `scripts/print-release-notes.ts`, so their shape is known
 * and narrow, and a renderer for it costs less than a dependency in every
 * bundle and every install channel. Anything unrecognised falls through as
 * plain text rather than being dropped.
 */

/** Built per call: a shared `g` regex carries `lastIndex` between callers. */
const inlinePattern = () => /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g

/** Only http(s) becomes a link; anything else renders as its own text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = inlinePattern()
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${String(match.index)}`

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded border border-border/60 bg-background px-1 py-0.5 font-mono text-[11px] text-foreground">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>)
    } else {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = safeHref(token.slice(split + 2, -1))
      nodes.push(href === null
        ? label
        : <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-brand-600 underline underline-offset-2 dark:text-brand-400">{label}</a>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const blocks: ReactNode[] = []
  // Release bodies carry `<!-- container:start -->` markers around the generated
  // image section. Recognise those two complete lines rather than treating
  // arbitrary release text as HTML that needs sanitising.
  const lines = notes
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '<!-- container:start -->' && line.trim() !== '<!-- container:end -->')

  let bullets: string[] = []
  let code: string[] | null = null

  const flushBullets = () => {
    if (bullets.length === 0) return
    const items = bullets
    blocks.push(
      <ul key={`ul-${String(blocks.length)}`} className="ml-4 list-disc space-y-1.5 marker:text-muted-foreground/60">
        {items.map((item, index) => (
          <li key={item.slice(0, 60) + String(index)}>{renderInline(item, `li-${String(index)}`)}</li>
        ))}
      </ul>,
    )
    bullets = []
  }

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (code === null) {
        flushBullets()
        code = []
      } else {
        blocks.push(
          <pre key={`pre-${String(blocks.length)}`} className="overflow-x-auto rounded-md border border-border/60 bg-background p-2.5 font-mono text-[11px] text-foreground">
            <code>{code.join('\n')}</code>
          </pre>,
        )
        code = null
      }
      continue
    }
    if (code !== null) {
      code.push(line)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushBullets()
      blocks.push(
        <p key={`h-${String(blocks.length)}`} className="mt-1 text-xs font-semibold uppercase tracking-wider text-foreground">
          {renderInline(heading[2] ?? '', `h-${String(blocks.length)}`)}
        </p>,
      )
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      bullets.push(bullet[1] ?? '')
      continue
    }

    if (line.trim() === '') {
      flushBullets()
      continue
    }

    flushBullets()
    blocks.push(<p key={`p-${String(blocks.length)}`}>{renderInline(line, `p-${String(blocks.length)}`)}</p>)
  }

  flushBullets()
  // An unterminated fence still shows its content rather than swallowing it.
  if (code !== null && code.length > 0) {
    blocks.push(
      <pre key={`pre-${String(blocks.length)}`} className="overflow-x-auto rounded-md border border-border/60 bg-background p-2.5 font-mono text-[11px] text-foreground">
        <code>{code.join('\n')}</code>
      </pre>,
    )
  }

  // Every block carries its own key, so no wrapper is needed here.
  return <div className="space-y-2.5 text-xs leading-relaxed text-muted-foreground">{blocks}</div>
}
