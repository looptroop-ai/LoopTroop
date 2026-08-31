import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Ban } from 'lucide-react'
import type { Ticket } from '@/hooks/useTickets'

export function CanceledView({ ticket }: { ticket?: Ticket }) {
  const reason = ticket?.cancelReason?.trim()
  // The artifacts and logs are optional casualties of the cancel dialog, so the
  // copy cannot promise they are all still there.
  const retained = ticket?.runtime?.artifactRoot ? 'Generated logs and artifacts are shown below when they were kept.' : ''

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
              This ticket execution was canceled. No further AI operations will occur. {retained}
            </p>
            {reason ? (
              <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Why it was canceled</div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/90">{reason}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* The ticket has to reach the panel: without it the panel never loads durable
          history, so a cancelled ticket showed an empty log, and it reads the phase as
          still live. */}
      <CollapsiblePhaseLogSection phase="CANCELED" ticket={ticket} className="px-4 pb-4" />
    </div>
  )
}
