import { Check, Copy } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

/**
 * The hover-revealed copy affordance used inside artifact rows. Distinct from
 * `CopyButton` in `RawTextDisplay.tsx`, which is always visible and labelled.
 */
export function TextCopyButton({ content, title, className = '' }: { content: string; title: string; className?: string }) {
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
            onClick={handleCopy}
            className={`opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-80 focus:opacity-100 outline-none ${className}`}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-center text-balance">{title}</TooltipContent>
      </Tooltip>
  )
}
