import { AlertTriangle, CircleArrowUp, Database, ExternalLink, Settings } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useProjects } from '@/hooks/useProjects'
import { useStartupStatus } from '@/hooks/useStartupStatus'
import { useUpdateStatus } from '@/hooks/useUpdateStatus'
import { ReleaseNotes } from './ReleaseNotes'

function formatStorageSource(source: string) {
  if (source === 'LOOPTROOP_APP_DB_PATH') return 'Custom database path override'
  if (source === 'LOOPTROOP_CONFIG_DIR') return 'Custom config directory override'
  return 'Default app storage location'
}

export function AboutDialog() {
  const { data: startupStatus } = useStartupStatus()
  const { data: projects } = useProjects()
  const { data: update, isLoading: isUpdateLoading } = useUpdateStatus()

  if (!startupStatus) {
    return (
      <div className="space-y-3 py-6 text-center">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading LoopTroop details...
        </p>
      </div>
    )
  }

  const attachedProjectCount = projects?.length ?? startupStatus.storage.restoredProjectCount
  const releaseUrl = update?.release?.url ?? 'https://github.com/looptroop-ai/LoopTroop/releases'
  const updateCommands = update
    ? [update.upgradeFirst, update.upgradeCommand, update.postUpgradeCommand].filter((command): command is string => command !== undefined)
    : []

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 text-sm text-muted-foreground leading-relaxed">
        LoopTroop stores application data centrally and keeps project-specific state inside each attached repository.
      </div>

      <Card className="rounded-xl border border-border/70 bg-card shadow-2xs">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/70 bg-muted text-muted-foreground">
              <CircleArrowUp className="h-4 w-4" />
            </div>
            Updates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isUpdateLoading && <p className="text-sm text-muted-foreground animate-pulse">Checking the latest published release…</p>}
          {update && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono">Current Version</p>
                  <p className="mt-1 font-mono text-sm font-semibold text-foreground">v{update.currentVersion}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono">Latest Version</p>
                  <p className="mt-1 font-mono text-sm font-semibold text-foreground">{update.latestVersion ? `v${update.latestVersion}` : 'Unavailable'}</p>
                </div>
              </div>

              <p className="text-sm text-muted-foreground">
                {update.updateAvailable
                  ? `A newer version is available for this ${update.installChannel} installation.`
                  : update.latestVersion
                    ? 'You are running the latest published version.'
                    : 'The latest release could not be checked. Cached information will be used when available.'}
              </p>

              {update.updateAvailable && (
                <div className="rounded-lg border border-border/70 bg-muted/35 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">How to update</p>
                  <ol className="space-y-2">
                    {updateCommands.map((command, index) => (
                      <li key={command} className="flex gap-2 text-xs">
                        <span className="mt-1 text-muted-foreground">{index + 1}.</span>
                        <code className="min-w-0 break-all rounded border border-border/60 bg-background px-2 py-1 font-mono text-foreground">{command}</code>
                      </li>
                    ))}
                  </ol>
                  {update.upgradeNote && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{update.upgradeNote}</p>}
                </div>
              )}

              <HoverCard openDelay={250} closeDelay={150}>
                <HoverCardTrigger asChild>
                  <Button variant="outline" size="sm" asChild>
                    <a href={releaseUrl} target="_blank" rel="noreferrer noopener">
                      Changelog
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                </HoverCardTrigger>
                <HoverCardContent align="start" className="w-[min(34rem,calc(100vw-2rem))] p-0">
                  <div className="border-b border-border/70 px-4 py-3">
                    <p className="font-semibold text-sm">{update.release?.name ?? 'LoopTroop releases'}</p>
                    {update.release?.publishedAt && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Published {new Date(update.release.publishedAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto px-4 py-3">
                    {update.release?.notes
                      ? <ReleaseNotes notes={update.release.notes} />
                      : <p className="text-xs leading-relaxed text-muted-foreground">Open GitHub to view all LoopTroop release notes.</p>}
                  </div>
                </HoverCardContent>
              </HoverCard>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl border border-border/70 bg-card shadow-2xs hover:border-brand-500/30 transition-all">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/20">
              <Settings className="h-4 w-4" />
            </div>
            Runtime
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono">Operating System</p>
            <p className="mt-1 text-sm font-medium text-foreground">{startupStatus.runtime.osLabel}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono mb-1">Application Location</p>
            <p className="break-all rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground shadow-2xs">{startupStatus.runtime.appRoot}</p>
          </div>
          {startupStatus.runtime.appPathWarning && (
            <div className="sm:col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p>{startupStatus.runtime.appPathWarning}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl border border-border/70 bg-card shadow-2xs hover:border-brand-500/30 transition-all">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/20">
              <Database className="h-4 w-4" />
            </div>
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono">Attached Projects</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{attachedProjectCount}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono">Storage Source</p>
              <p className="mt-1 text-sm font-medium text-foreground">{formatStorageSource(startupStatus.storage.source)}</p>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono mb-1">App Database</p>
            <p className="break-all rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground shadow-2xs">{startupStatus.storage.dbPath}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/90 font-mono mb-1">Config Directory</p>
            <p className="break-all rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground shadow-2xs">{startupStatus.storage.configDir}</p>
          </div>
          <div className="pt-1">
            <p className="text-xs text-muted-foreground mb-1.5">
              Each attached project stores its local LoopTroop state in:
            </p>
            <p className="inline-block rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground shadow-2xs">&lt;repo&gt;/.looptroop/</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              The exact repository path is shown in Project Details.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
