import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  type PrdDocument,
  PRD_TECHNICAL_SECTION_CONFIG,
  getPrdEpicAnchorId,
  getPrdProductAnchorId,
  getPrdRisksAnchorId,
  getPrdScopeAnchorId,
  getPrdUserStoryAnchorId,
  getPrdTechnicalRequirementAnchorId,
  getPrdTechnicalRequirementsAnchorId,
} from '@/lib/prdDocument'
import { CollapsibleSection } from './ArtifactContentViewer'

function MetaPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-wider text-foreground', className)}>
      {children}
    </span>
  )
}

function StringList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>
  }

  return (
    <ul className="space-y-1.5 text-sm text-foreground/95">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

export function PrdDocumentView({
  document,
  className,
}: {
  document: PrdDocument
  className?: string
}) {
  const technicalSections = PRD_TECHNICAL_SECTION_CONFIG
    .map((section) => ({
      ...section,
      values: document.technical_requirements[section.key] ?? [],
    }))
    .filter((section) => section.values.length > 0)

  return (
    <div className={cn('space-y-5', className)}>
      <section
        id={getPrdProductAnchorId()}
        className="scroll-mt-6"
      >
        <CollapsibleSection
          title={(
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">Product</div>
              <MetaPill>Status: {document.status}</MetaPill>
              {document.source_interview.content_sha256 ? <MetaPill>Interview-linked</MetaPill> : null}
            </div>
          )}
          defaultOpen
          className="rounded-2xl border border-border bg-gradient-to-br from-background via-background to-muted/40 shadow-sm"
          triggerClassName="px-4 py-4"
          contentClassName="px-4 pb-4"
        >
          <div className="space-y-3">
            <div className="rounded-xl border border-border/70 bg-background/70 p-3">
              <div className="section-label">Problem Statement</div>
              <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                {document.product.problem_statement || 'No problem statement recorded.'}
              </div>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/70 p-3">
              <div className="section-label">Target Users</div>
              <div className="mt-2">
                <StringList items={document.product.target_users} emptyLabel="No target users recorded." />
              </div>
            </div>
          </div>
        </CollapsibleSection>
      </section>

      <section
        id={getPrdScopeAnchorId()}
        className="scroll-mt-6"
      >
        <CollapsibleSection
          title={(
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">Scope</div>
            </div>
          )}
          defaultOpen
          className="rounded-2xl border border-border bg-background/80 shadow-sm"
          triggerClassName="px-4 py-4"
          contentClassName="px-4 pb-4"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-background/70 p-3">
              <div className="section-label">In Scope</div>
              <div className="mt-2">
                <StringList items={document.scope.in_scope} emptyLabel="No in-scope items recorded." />
              </div>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/70 p-3">
              <div className="section-label">Out Of Scope</div>
              <div className="mt-2">
                <StringList items={document.scope.out_of_scope} emptyLabel="No out-of-scope items recorded." />
              </div>
            </div>
          </div>
        </CollapsibleSection>
      </section>

      <section
        id={getPrdTechnicalRequirementsAnchorId()}
        className="scroll-mt-6"
      >
        <CollapsibleSection
          title={(
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">Technical Requirements</div>
            </div>
          )}
          defaultOpen
          className="rounded-2xl border border-border bg-background/80 shadow-sm"
          triggerClassName="px-4 py-4"
          contentClassName="px-4 pb-4"
        >
          <div className="grid gap-3 md:grid-cols-2">
            {technicalSections.length > 0 ? technicalSections.map((section) => (
              <div
                key={section.key}
                id={getPrdTechnicalRequirementAnchorId(section.key)}
                className="rounded-xl border border-border/70 bg-background/70 p-3 scroll-mt-6"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="section-label">{section.label}</div>
                </div>
                <div className="mt-2">
                  <StringList items={section.values} emptyLabel="No requirements recorded." />
                </div>
              </div>
            )) : (
              <div className="text-xs text-muted-foreground">No technical requirements recorded.</div>
            )}
          </div>
        </CollapsibleSection>
      </section>

      <section
        id={getPrdRisksAnchorId()}
        className="scroll-mt-6"
      >
        <CollapsibleSection
          title={(
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">Risks</div>
            </div>
          )}
          defaultOpen
          className="rounded-2xl border border-border bg-background/80 shadow-sm"
          triggerClassName="px-4 py-4"
          contentClassName="px-4 pb-4"
        >
          <StringList items={document.risks} emptyLabel="No explicit risks recorded." />
        </CollapsibleSection>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-foreground">Epics</div>
          <MetaPill>{document.epics.length} epic{document.epics.length === 1 ? '' : 's'}</MetaPill>
          <MetaPill>
            {document.epics.reduce((sum, epic) => sum + epic.user_stories.length, 0)} user stor{document.epics.reduce((sum, epic) => sum + epic.user_stories.length, 0) === 1 ? 'y' : 'ies'}
          </MetaPill>
        </div>

        {document.epics.map((epic) => (
          <section
            key={epic.id}
            id={getPrdEpicAnchorId(epic.id)}
            className="scroll-mt-6"
          >
            <CollapsibleSection
              title={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px]">{epic.id}</Badge>
                  <span className="text-sm font-semibold text-foreground">{epic.title}</span>
                </div>
              }
              defaultOpen={false}
            >
              <div className="space-y-4">
                <div className="rounded-xl border border-border/70 bg-background/70 p-3">
                  <div className="section-label">Objective</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {epic.objective || 'No objective recorded.'}
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background/70 p-3">
                  <div className="section-label">Epic Implementation Steps</div>
                  <div className="mt-2">
                    <StringList items={epic.implementation_steps} emptyLabel="No implementation steps recorded." />
                  </div>
                </div>

                <div className="space-y-3">
                  {epic.user_stories.map((story) => (
                    <article
                      key={story.id}
                      id={getPrdUserStoryAnchorId(epic.id, story.id)}
                      className="rounded-xl border border-border bg-background/85 p-4 shadow-sm scroll-mt-6"
                    >
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="font-mono text-[10px]">{story.id}</Badge>
                          <div className="text-sm font-medium text-foreground">{story.title}</div>
                        </div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="rounded-xl border border-border/70 bg-muted/20 p-3 md:col-span-1">
                            <div className="section-label">Acceptance Criteria</div>
                            <div className="mt-2">
                              <StringList items={story.acceptance_criteria} emptyLabel="No acceptance criteria recorded." />
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/70 bg-muted/20 p-3 md:col-span-1">
                            <div className="section-label">Implementation Steps</div>
                            <div className="mt-2">
                              <StringList items={story.implementation_steps} emptyLabel="No implementation steps recorded." />
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/70 bg-muted/20 p-3 md:col-span-1">
                            <div className="section-label">Verification Commands</div>
                            <div className="mt-2">
                              <StringList items={story.verification.required_commands.map((command) => renderCommandSpec(command))} emptyLabel="No verification commands recorded." />
                            </div>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </CollapsibleSection>
          </section>
        ))}
      </section>
    </div>
  )
}
import { renderCommandSpec } from '@shared/commandSpec'
