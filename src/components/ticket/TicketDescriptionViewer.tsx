import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface TicketDescriptionViewerProps {
  description: string
  className?: string
}

type Block =
  | { type: 'heading'; level: number; content: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'code'; language: string; content: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'rule' }

interface ListItem {
  content: string
  checked?: boolean
}

interface FenceStart {
  marker: '`' | '~'
  length: number
  language: string
}

const LINK_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function normalizeDescription(description: string): string[] {
  return description.replace(/\r\n?/g, '\n').split('\n')
}

function parseFenceStart(line: string): FenceStart | null {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  const fence = match[1] ?? ''
  if (!fence) return null
  const marker = fence[0] as '`' | '~'
  return {
    marker,
    length: fence.length,
    language: (match[2] ?? '').trim().split(/\s+/)[0] ?? '',
  }
}

function isFenceEnd(line: string, fence: FenceStart): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith(fence.marker.repeat(fence.length))
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line)
}

function isBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line)
}

function isRule(line: string): boolean {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)
}

function parseListItem(line: string): { ordered: boolean; content: string; checked?: boolean } | null {
  const unordered = line.match(/^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/)
  if (unordered) {
    return {
      ordered: false,
      checked: unordered[1] ? unordered[1].toLowerCase() === 'x' : undefined,
      content: unordered[2] ?? '',
    }
  }

  const ordered = line.match(/^\s*\d+[.)]\s+(?:\[([ xX])\]\s+)?(.+)$/)
  if (!ordered) return null
  return {
    ordered: true,
    checked: ordered[1] ? ordered[1].toLowerCase() === 'x' : undefined,
    content: ordered[2] ?? '',
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index]
  const next = lines[index + 1]
  return Boolean(current?.includes('|') && next?.includes('|') && isTableDelimiter(next))
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  return (
    line.trim() === '' ||
    parseFenceStart(line) !== null ||
    isHeading(line) ||
    isBlockquote(line) ||
    isRule(line) ||
    parseListItem(line) !== null ||
    isTableStart(lines, index)
  )
}

function parseBlocks(description: string): Block[] {
  const lines = normalizeDescription(description)
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = parseFenceStart(line)
    if (fence) {
      const content: string[] = []
      index += 1
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (isFenceEnd(current, fence)) break
        content.push(current)
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', language: fence.language, content: content.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] ?? '').length, content: (heading[2] ?? '').trim() })
      index += 1
      continue
    }

    if (isRule(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (isBlockquote(line)) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (!isBlockquote(current)) break
        quoteLines.push(current.replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    const firstListItem = parseListItem(line)
    if (firstListItem) {
      const ordered = firstListItem.ordered
      const items: ListItem[] = []
      while (index < lines.length) {
        const item = parseListItem(lines[index] ?? '')
        if (!item || item.ordered !== ordered) break
        items.push({ content: item.content, checked: item.checked })
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index] ?? '')
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (current.trim() === '' || !current.includes('|')) break
        rows.push(splitTableRow(current))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index] ?? '')
      index += 1
    }
    if (paragraphLines.length > 0) blocks.push({ type: 'paragraph', lines: paragraphLines })
  }

  return blocks
}

function getSafeHref(rawTarget: string): string | null {
  const href = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+/)[0] ?? ''
  if (!href) return null

  const compact = stripUnsafeHrefChars(href).toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:') || compact.startsWith('data:')) return null

  try {
    // URI encoding is the final, context-specific boundary before this value
    // reaches an href. React also escapes attributes, but encoding here keeps
    // text copied from the description DOM from being reinterpreted as markup.
    if (!LINK_SCHEME_PATTERN.test(href)) return encodeURI(href)

    const url = new URL(href)
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? encodeURI(href) : null
  } catch {
    return null
  }
}

function stripUnsafeHrefChars(value: string): string {
  let compact = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) continue
    compact += char
  }
  return compact
}

function findNextToken(text: string): { index: number; token: string } | null {
  const tokens = ['`', '[', '**', '__', '~~', '*']
  let next: { index: number; token: string } | null = null

  for (const token of tokens) {
    const index = text.indexOf(token)
    if (index === -1) continue
    if (!next || index < next.index || (index === next.index && token.length > next.token.length)) {
      next = { index, token }
    }
  }

  return next
}

function findLinkTargetEnd(text: string, startIndex: number): number {
  let depth = 0

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      if (depth === 0) return index
      depth -= 1
    }
  }

  return -1
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let remaining = text
  let offset = 0

  while (remaining.length > 0) {
    const next = findNextToken(remaining)
    if (!next) {
      nodes.push(remaining)
      break
    }

    if (next.index > 0) {
      nodes.push(remaining.slice(0, next.index))
      remaining = remaining.slice(next.index)
      offset += next.index
      continue
    }

    if (next.token === '`') {
      const end = remaining.indexOf('`', 1)
      if (end === -1) {
        nodes.push('`')
        remaining = remaining.slice(1)
        offset += 1
        continue
      }
      nodes.push(
        <code key={`${keyPrefix}-code-${offset}`} className="rounded border border-border/60 bg-background px-1 py-0.5 font-mono text-[0.85em] text-foreground">
          {remaining.slice(1, end)}
        </code>,
      )
      remaining = remaining.slice(end + 1)
      offset += end + 1
      continue
    }

    if (next.token === '[') {
      const labelEnd = remaining.indexOf(']', 1)
      if (labelEnd === -1 || remaining[labelEnd + 1] !== '(') {
        nodes.push('[')
        remaining = remaining.slice(1)
        offset += 1
        continue
      }
      const targetEnd = findLinkTargetEnd(remaining, labelEnd + 2)
      if (targetEnd === -1) {
        nodes.push('[')
        remaining = remaining.slice(1)
        offset += 1
        continue
      }

      const label = remaining.slice(1, labelEnd)
      const safeHref = getSafeHref(remaining.slice(labelEnd + 2, targetEnd))
      const content = renderInline(label, `${keyPrefix}-link-${offset}`)
      const isExternalHttpLink = safeHref ? /^https?:/i.test(safeHref) : false
      nodes.push(
        safeHref ? (
          <a
            key={`${keyPrefix}-link-${offset}`}
            href={safeHref}
            className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
            rel={isExternalHttpLink ? 'noreferrer' : undefined}
            target={isExternalHttpLink ? '_blank' : undefined}
          >
            {content}
          </a>
        ) : (
          <span key={`${keyPrefix}-unsafe-link-${offset}`}>{content}</span>
        ),
      )
      remaining = remaining.slice(targetEnd + 1)
      offset += targetEnd + 1
      continue
    }

    const delimiter = next.token
    const end = remaining.indexOf(delimiter, delimiter.length)
    if (end === -1) {
      nodes.push(delimiter)
      remaining = remaining.slice(delimiter.length)
      offset += delimiter.length
      continue
    }

    const content = renderInline(remaining.slice(delimiter.length, end), `${keyPrefix}-${delimiter}-${offset}`)
    if (delimiter === '**' || delimiter === '__') {
      nodes.push(<strong key={`${keyPrefix}-strong-${offset}`} className="font-semibold text-foreground">{content}</strong>)
    } else if (delimiter === '~~') {
      nodes.push(<del key={`${keyPrefix}-del-${offset}`}>{content}</del>)
    } else {
      nodes.push(<em key={`${keyPrefix}-em-${offset}`} className="text-foreground/90">{content}</em>)
    }
    remaining = remaining.slice(end + delimiter.length)
    offset += end + delimiter.length
  }

  return nodes
}

function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-br-${index}`} />)
    nodes.push(<Fragment key={`${keyPrefix}-line-${index}`}>{renderInline(line, `${keyPrefix}-${index}`)}</Fragment>)
  })
  return nodes
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const className = cn('mb-1 break-words font-semibold text-foreground [overflow-wrap:anywhere]', block.level <= 2 ? 'mt-3 text-base' : 'mt-2 text-sm')
      const content = renderInline(block.content, `heading-${index}`)
      const headingLevel = Math.min(block.level + 2, 6)
      if (headingLevel === 3) return <h3 key={index} className={className}>{content}</h3>
      if (headingLevel === 4) return <h4 key={index} className={className}>{content}</h4>
      if (headingLevel === 5) return <h5 key={index} className={className}>{content}</h5>
      return <h6 key={index} className={className}>{content}</h6>
    }
    case 'paragraph':
      return (
        <p key={index} className="my-2 break-words leading-6 [overflow-wrap:anywhere]">
          {renderLines(block.lines, `paragraph-${index}`)}
        </p>
      )
    case 'blockquote':
      return (
        <blockquote key={index} className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground/90">
          {renderLines(block.lines, `quote-${index}`)}
        </blockquote>
      )
    case 'code':
      return (
        <pre key={index} className="my-2 max-w-full overflow-x-auto rounded-md border border-border/60 bg-background p-3 text-xs leading-5 text-foreground">
          <code className="font-mono">{block.content}</code>
        </pre>
      )
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      return (
        <ListTag key={index} className={cn('my-2 space-y-1 pl-5 leading-6', block.ordered ? 'list-decimal' : 'list-disc')}>
          {block.items.map((item, itemIndex) => (
            item.checked === undefined ? (
              <li key={itemIndex} className="pl-1 [overflow-wrap:anywhere]">
                {renderInline(item.content, `list-${index}-${itemIndex}`)}
              </li>
            ) : (
              <li key={itemIndex} className="-ml-5 flex list-none items-start gap-2 [overflow-wrap:anywhere]">
                <input
                  aria-label={item.checked ? 'Completed task' : 'Incomplete task'}
                  checked={item.checked}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
                  disabled
                  readOnly
                  type="checkbox"
                />
                <span>{renderInline(item.content, `task-${index}-${itemIndex}`)}</span>
              </li>
            )
          ))}
        </ListTag>
      )
    }
    case 'table':
      return (
        <div key={index} className="my-3 max-w-full overflow-x-auto rounded-md border border-border/60">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-muted/60 text-foreground">
              <tr>
                {block.headers.map((header, headerIndex) => (
                  <th key={headerIndex} className="border-b border-border/60 px-3 py-2 font-semibold">
                    {renderInline(header, `table-${index}-head-${headerIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border/40 first:border-t-0">
                  {block.headers.map((_, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 align-top">
                      {renderInline(row[cellIndex] ?? '', `table-${index}-row-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'rule':
      return <hr key={index} className="my-3 border-border/70" />
  }
}

export function TicketDescriptionViewer({ description, className }: TicketDescriptionViewerProps) {
  const blocks = parseBlocks(description)

  return (
    <div className={cn('text-sm leading-6 text-muted-foreground', className)}>
      {blocks.map(renderBlock)}
    </div>
  )
}
