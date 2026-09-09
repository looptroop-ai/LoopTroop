import { useMemo } from 'react'
import { encode } from 'gpt-tokenizer'
import { Check, Copy } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { StatPill, StatPillRow } from './artifactViewers/StatPillRow'

export function CopyButton({ content, className = '', title = 'Copy raw output' }: { content: string; className?: string; title?: string }) {
  const [copied, copyToClipboard] = useCopyToClipboard()

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    copyToClipboard(content)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={handleCopy}
          className={`inline-flex items-center justify-center p-1 rounded hover:bg-muted transition-colors ${className}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-center text-balance">{title}</TooltipContent>
    </Tooltip>
  )
}

export function RawDisplayStats({ content }: { content: string }) {
  const tokenCount = useMemo(() => encode(content).length, [content])
  const lineCount = content.split('\n').length
  const charCount = content.length

  return (
    <StatPillRow>
      <StatPill>{lineCount.toLocaleString()} Lines</StatPill>
      <StatPill>{charCount.toLocaleString()} Characters</StatPill>
      <StatPill>{tokenCount.toLocaleString()} Tokens (GPT-5 tokenizer)</StatPill>
    </StatPillRow>
  )
}

export function RawDisplayPre({ content }: { content: string }) {
  return (
    <div className="min-w-0 max-w-full w-full overflow-hidden">
      <pre className="min-w-0 max-w-full w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere] rounded border border-border bg-background p-2 font-mono text-[11px]">
        {content}
      </pre>
    </div>
  )
}

export function RawContentWithCopy({ content }: { content: string }) {
  const displayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])

  return (
    <div className="space-y-3 min-w-0 max-w-full">
      <div className="flex items-center justify-between gap-2">
        <CopyButton content={content} />
        <RawDisplayStats content={displayContent} />
      </div>
      <RawDisplayPre content={displayContent} />
    </div>
  )
}
