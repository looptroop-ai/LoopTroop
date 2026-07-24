import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Ban } from 'lucide-react'

export function CanceledView() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 shrink-0">
        <Card className="rounded-xl border border-border/70 bg-card shadow-2xs">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-mono font-semibold flex items-center gap-2 text-muted-foreground">
              <Ban className="h-4 w-4 text-muted-foreground/70" />
              Execution Canceled
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-muted/40 text-muted-foreground border-border/70 font-mono text-xs font-medium">
                Canceled
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This ticket execution was canceled. No further AI operations will occur, but all generated logs and artifacts remain accessible below.
            </p>
          </CardContent>
        </Card>
      </div>

      <CollapsiblePhaseLogSection phase="CANCELED" className="px-4 pb-4" />
    </div>
  )
}
