import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  type PrdApprovalDraft,
  type PrdEpic,
  type PrdTechnicalRequirementKey,
  type PrdUserStory,
  PRD_TECHNICAL_SECTION_CONFIG,
} from '@/lib/prdDocument'
import { CollapsibleSection } from './ArtifactContentViewer'
import { CommandSpecListEditor } from './CommandSpecListEditor'

interface PrdApprovalEditorProps {
  draft: PrdApprovalDraft
  disabled?: boolean
  onChange: (draft: PrdApprovalDraft) => void
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (toIndex < 0 || toIndex >= items.length) return items
  const nextItems = [...items]
  const [item] = nextItems.splice(fromIndex, 1)
  if (item === undefined) return items
  nextItems.splice(toIndex, 0, item)
  return nextItems
}

function buildNewEpic(index: number): PrdEpic {
  return {
    id: `EPIC-${index + 1}`,
    title: '',
    objective: '',
    implementation_steps: [],
    user_stories: [],
  }
}

function buildNewStory(epicIndex: number, storyIndex: number): PrdUserStory {
  return {
    id: `US-${epicIndex + 1}-${storyIndex + 1}`,
    title: '',
    acceptance_criteria: [],
    implementation_steps: [],
    verification: {
      required_commands: [],
    },
  }
}

function StringListEditor({
  label,
  items,
  disabled = false,
  emptyLabel,
  addLabel,
  onChange,
}: {
  label: string
  items: string[]
  disabled?: boolean
  emptyLabel: string
  addLabel: string
  onChange: (nextItems: string[]) => void
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="section-label">{label}</div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          disabled={disabled}
          onClick={() => onChange([...items, ''])}
        >
          {addLabel}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={`${label}-${index}`} className="flex items-start gap-2">
              <textarea
                rows={2}
                value={item}
                disabled={disabled}
                onChange={(event) => onChange(items.map((current, currentIndex) => currentIndex === index ? event.target.value : current))}
                className="min-h-[70px] flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-8 px-0"
                  disabled={disabled || index === 0}
                  onClick={() => onChange(moveItem(items, index, index - 1))}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-8 px-0"
                  disabled={disabled || index === items.length - 1}
                  onClick={() => onChange(moveItem(items, index, index + 1))}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-8 px-0"
                  disabled={disabled}
                  onClick={() => onChange(items.filter((_, currentIndex) => currentIndex !== index))}
                >
                  ×
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StoryEditor({
  story,
  storyIndex,
  totalStories,
  disabled = false,
  onChange,
  onRemove,
  onMove,
}: {
  story: PrdUserStory
  storyIndex: number
  totalStories: number
  disabled?: boolean
  onChange: (story: PrdUserStory) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) {
  return (
    <article className="rounded-xl border border-border bg-background/85 p-4 shadow-sm">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">{story.id || `US-${storyIndex + 1}`}</Badge>
          <span className="text-sm font-medium text-foreground">{story.title || 'Untitled user story'}</span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={disabled || storyIndex === 0}
              onClick={() => onMove(-1)}
            >
              Move Up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={disabled || storyIndex === totalStories - 1}
              onClick={() => onMove(1)}
            >
              Move Down
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={disabled}
              onClick={onRemove}
            >
              Remove
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="section-label">Story ID</span>
            <input
              value={story.id}
              disabled={disabled}
              onChange={(event) => onChange({ ...story, id: event.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="space-y-1">
            <span className="section-label">Title</span>
            <input
              value={story.title}
              disabled={disabled}
              onChange={(event) => onChange({ ...story, title: event.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <StringListEditor
            label="Acceptance Criteria"
            items={story.acceptance_criteria}
            disabled={disabled}
            emptyLabel="No acceptance criteria recorded."
            addLabel="Add Criterion"
            onChange={(acceptance_criteria) => onChange({ ...story, acceptance_criteria })}
          />
          <StringListEditor
            label="Implementation Steps"
            items={story.implementation_steps}
            disabled={disabled}
            emptyLabel="No implementation steps recorded."
            addLabel="Add Step"
            onChange={(implementation_steps) => onChange({ ...story, implementation_steps })}
          />
          <div>
            <div className="section-label mb-2">Verification Commands</div>
            <CommandSpecListEditor
              commands={story.verification.required_commands}
              disabled={disabled}
              onChange={(required_commands) => onChange({ ...story, verification: { required_commands } })}
            />
          </div>
        </div>
      </div>
    </article>
  )
}

function EpicEditor({
  epic,
  epicIndex,
  totalEpics,
  disabled = false,
  onChange,
  onRemove,
  onMove,
}: {
  epic: PrdEpic
  epicIndex: number
  totalEpics: number
  disabled?: boolean
  onChange: (epic: PrdEpic) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) {
  return (
    <CollapsibleSection
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">{epic.id || `EPIC-${epicIndex + 1}`}</Badge>
          <span className="truncate text-sm font-semibold text-foreground">{epic.title || 'Untitled epic'}</span>
          <Badge variant="outline" className="text-[10px]">
            {epic.user_stories.length} stor{epic.user_stories.length === 1 ? 'y' : 'ies'}
          </Badge>
        </div>
      }
      defaultOpen={false}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={disabled || epicIndex === 0}
            onClick={() => onMove(-1)}
          >
            Move Up
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={disabled || epicIndex === totalEpics - 1}
            onClick={() => onMove(1)}
          >
            Move Down
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={disabled}
            onClick={onRemove}
          >
            Remove Epic
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="section-label">Epic ID</span>
            <input
              value={epic.id}
              disabled={disabled}
              onChange={(event) => onChange({ ...epic, id: event.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="space-y-1">
            <span className="section-label">Title</span>
            <input
              value={epic.title}
              disabled={disabled}
              onChange={(event) => onChange({ ...epic, title: event.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>

        <label className="space-y-1">
          <span className="section-label">Objective</span>
          <textarea
            rows={3}
            value={epic.objective}
            disabled={disabled}
            onChange={(event) => onChange({ ...epic, objective: event.target.value })}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>

        <StringListEditor
          label="Epic Implementation Steps"
          items={epic.implementation_steps}
          disabled={disabled}
          emptyLabel="No implementation steps recorded."
          addLabel="Add Step"
          onChange={(implementation_steps) => onChange({ ...epic, implementation_steps })}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="section-label">User Stories</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={disabled}
              onClick={() => onChange({
                ...epic,
                user_stories: [...epic.user_stories, buildNewStory(epicIndex, epic.user_stories.length)],
              })}
            >
              Add User Story
            </Button>
          </div>

          {epic.user_stories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
              No user stories recorded yet.
            </div>
          ) : (
            epic.user_stories.map((story, storyIndex) => (
              <StoryEditor
                key={`${story.id}-${storyIndex}`}
                story={story}
                storyIndex={storyIndex}
                totalStories={epic.user_stories.length}
                disabled={disabled}
                onChange={(nextStory) => onChange({
                  ...epic,
                  user_stories: epic.user_stories.map((currentStory, currentIndex) => currentIndex === storyIndex ? nextStory : currentStory),
                })}
                onRemove={() => onChange({
                  ...epic,
                  user_stories: epic.user_stories.filter((_, currentIndex) => currentIndex !== storyIndex),
                })}
                onMove={(direction) => onChange({
                  ...epic,
                  user_stories: moveItem(epic.user_stories, storyIndex, storyIndex + direction),
                })}
              />
            ))
          )}
        </div>
      </div>
    </CollapsibleSection>
  )
}

export function PrdApprovalEditor({ draft, disabled = false, onChange }: PrdApprovalEditorProps) {
  const setTechnicalRequirement = (key: PrdTechnicalRequirementKey, value: string[]) => {
    onChange({
      ...draft,
      technical_requirements: {
        ...draft.technical_requirements,
        [key]: value,
      },
    })
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
        <div className="font-semibold">Structured PRD editor</div>
        <p className="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-200/90">
          This mode edits the PRD content while keeping ticket metadata, interview linkage, status, and approval fields protected.
          Use the YAML tab only if you need a full-power edit.
        </p>
      </div>

      <label className="space-y-1 rounded-2xl border border-border bg-background/80 p-4 shadow-sm">
        <span className="section-label">Problem Statement</span>
        <textarea
          rows={4}
          value={draft.product.problem_statement}
          disabled={disabled}
          onChange={(event) => onChange({
            ...draft,
            product: {
              ...draft.product,
              problem_statement: event.target.value,
            },
          })}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </label>

      <div className="grid gap-4 xl:grid-cols-2">
        <StringListEditor
          label="Target Users"
          items={draft.product.target_users}
          disabled={disabled}
          emptyLabel="No target users recorded."
          addLabel="Add User"
          onChange={(target_users) => onChange({
            ...draft,
            product: {
              ...draft.product,
              target_users,
            },
          })}
        />
        <StringListEditor
          label="Risks"
          items={draft.risks}
          disabled={disabled}
          emptyLabel="No risks recorded."
          addLabel="Add Risk"
          onChange={(risks) => onChange({ ...draft, risks })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <StringListEditor
          label="In Scope"
          items={draft.scope.in_scope}
          disabled={disabled}
          emptyLabel="No in-scope items recorded."
          addLabel="Add Scope Item"
          onChange={(in_scope) => onChange({
            ...draft,
            scope: {
              ...draft.scope,
              in_scope,
            },
          })}
        />
        <StringListEditor
          label="Out Of Scope"
          items={draft.scope.out_of_scope}
          disabled={disabled}
          emptyLabel="No out-of-scope items recorded."
          addLabel="Add Exclusion"
          onChange={(out_of_scope) => onChange({
            ...draft,
            scope: {
              ...draft.scope,
              out_of_scope,
            },
          })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {PRD_TECHNICAL_SECTION_CONFIG.map((section) => (
          <StringListEditor
            key={section.key}
            label={section.label}
            items={draft.technical_requirements[section.key]}
            disabled={disabled}
            emptyLabel={`No ${section.label.toLowerCase()} recorded.`}
            addLabel="Add Entry"
            onChange={(value) => setTechnicalRequirement(section.key, value)}
          />
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">Epics</div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-[11px]"
            disabled={disabled}
            onClick={() => onChange({
              ...draft,
              epics: [...draft.epics, buildNewEpic(draft.epics.length)],
            })}
          >
            Add Epic
          </Button>
        </div>

        {draft.epics.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
            No epics recorded yet.
          </div>
        ) : (
          draft.epics.map((epic, epicIndex) => (
            <EpicEditor
              key={`${epic.id}-${epicIndex}`}
              epic={epic}
              epicIndex={epicIndex}
              totalEpics={draft.epics.length}
              disabled={disabled}
              onChange={(nextEpic) => onChange({
                ...draft,
                epics: draft.epics.map((currentEpic, currentIndex) => currentIndex === epicIndex ? nextEpic : currentEpic),
              })}
              onRemove={() => onChange({
                ...draft,
                epics: draft.epics.filter((_, currentIndex) => currentIndex !== epicIndex),
              })}
              onMove={(direction) => onChange({
                ...draft,
                epics: moveItem(draft.epics, epicIndex, epicIndex + direction),
              })}
            />
          ))
        )}
      </div>
    </div>
  )
}
