import { AlertTriangle } from 'lucide-react'
import { isExternalTargetFile } from '@shared/beadTargets'
import { Badge } from '@/components/ui/badge'

export function ExternalFilesBadge({ targetFiles }: { targetFiles: string[] }) {
  const externalFiles = targetFiles.filter(isExternalTargetFile)
  if (externalFiles.length === 0) return null

  return (
    <Badge
      role="note"
      variant="outline"
      className="shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-300"
      title={`Targets outside the repository:\n${externalFiles.join('\n')}`}
      aria-label={`External files: ${externalFiles.join(', ')}`}
    >
      <AlertTriangle aria-hidden="true" className="h-3 w-3" />
      External files
    </Badge>
  )
}
