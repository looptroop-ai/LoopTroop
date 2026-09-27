import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Project } from '@/hooks/useProjects'
import { ProjectsPanel } from '../ProjectsPanel'

const projectQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }))

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: projectQuery.data, isLoading: projectQuery.isLoading }),
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" role="menuitem" onClick={onClick}>{children}</button>
  ),
}))

vi.mock('../ProjectForm', () => ({
  ProjectForm: ({
    onClose,
    onBack,
    onDirtyChange,
    project,
  }: {
    onClose: () => void
    onBack: () => void
    onDirtyChange?: (dirty: boolean) => void
    project?: { name: string }
  }) => (
    <div data-testid="project-form">
      <p>{project ? `Editing ${project.name}` : 'Creating project'}</p>
      <button type="button" onClick={() => onDirtyChange?.(true)}>Mark dirty</button>
      <button type="button" onClick={onBack}>Back to list</button>
      <button type="button" onClick={onClose}>Close form</button>
    </div>
  ),
}))

beforeEach(() => {
  projectQuery.data = []
  projectQuery.isLoading = false
})

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Project',
    shortname: 'PROJ',
    icon: '📁',
    color: '#2563eb',
    folderPath: '/workspace/project',
    profileId: null,
    councilMembers: null,
    maxIterations: null,
    perIterationTimeout: null,
    executionSetupTimeout: null,
    gitHookPolicy: null,
    councilResponseTimeout: null,
    minCouncilQuorum: null,
    interviewQuestions: null,
    ignoreMode: 'local',
    ticketCounter: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderPanel(onClose = vi.fn(), onDirtyChange = vi.fn()) {
  return render(
    <TooltipProvider>
      <ProjectsPanel onClose={onClose} onDirtyChange={onDirtyChange} />
    </TooltipProvider>,
  )
}

function orderedProjectNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.group.relative')]
    .map((card) => card.querySelector('.font-semibold')?.textContent ?? '')
}

function projectList() {
  return [
    makeProject({ id: 1, name: 'Beta', shortname: 'BET', icon: 'data:image/png;base64,beta', ticketCounter: 5, createdAt: '2024-01-01', updatedAt: '2025-01-01' }),
    makeProject({ id: 2, name: 'Alpha', shortname: 'ALP', ticketCounter: 1, createdAt: '2025-01-01', updatedAt: '2024-01-01' }),
    makeProject({ id: 3, name: 'Gamma', shortname: 'GAM', ticketCounter: 3, createdAt: '2023-01-01', updatedAt: '2026-01-01' }),
  ]
}

function selectSortOption(next: string) {
  fireEvent.click(screen.getByRole('menuitem', { name: next }))
}

describe('ProjectsPanel', () => {
  it('shows loading and empty states before a project list is available', () => {
    projectQuery.data = undefined
    projectQuery.isLoading = true
    const view = renderPanel()
    expect(view.container.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.getByText('0 projects')).toBeInTheDocument()

    projectQuery.data = []
    projectQuery.isLoading = false
    view.rerender(
      <TooltipProvider>
        <ProjectsPanel onClose={vi.fn()} />
      </TooltipProvider>,
    )
    expect(screen.getByText('No projects yet. Create your first project to get started.')).toBeInTheDocument()
    expect(screen.getByText('0 projects')).toBeInTheDocument()
  })

  it.each([
    ['Number of tickets', ['Alpha', 'Gamma', 'Beta']],
    ['Project created time', ['Gamma', 'Beta', 'Alpha']],
    ['Last update', ['Alpha', 'Beta', 'Gamma']],
  ])('sorts projects by %s', async (sortLabel, expectedOrder) => {
    projectQuery.data = projectList()
    const view = renderPanel()
    expect(orderedProjectNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(screen.getByText('5 tickets')).toBeInTheDocument()
    expect(screen.getByText('1 ticket')).toBeInTheDocument()
    expect(view.container.querySelector('img[alt=""]')).toHaveAttribute('src', 'data:image/png;base64,beta')

    selectSortOption(sortLabel)
    expect(orderedProjectNames()).toEqual(expectedOrder)
  })

  it('toggles ticket sorting to descending order', async () => {
    projectQuery.data = projectList()
    const view = renderPanel()
    selectSortOption('Number of tickets')
    fireEvent.click(view.container.querySelector('button.h-8.px-2')!)
    expect(orderedProjectNames()).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('returns from create and edit forms to the list and reports dirty state', () => {
    projectQuery.data = [makeProject({ name: 'Editable project' })]
    const onClose = vi.fn()
    const onDirtyChange = vi.fn()
    renderPanel(onClose, onDirtyChange)

    fireEvent.click(screen.getByRole('button', { name: 'Create New Project' }))
    expect(screen.getByText('Creating project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mark dirty' }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('Editable project')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Editing Editable project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close form' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
