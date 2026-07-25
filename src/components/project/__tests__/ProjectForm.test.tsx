import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectForm } from '../ProjectForm'
import { TooltipProvider } from '@/components/ui/tooltip'

const mockProjectMutations = vi.hoisted(() => ({
  create: {
    mutate: vi.fn(),
    isPending: false,
    error: null as Error | null,
  },
  update: {
    mutate: vi.fn(),
    isPending: false,
    error: null as Error | null,
  },
  remove: {
    mutate: vi.fn(),
    isPending: false,
    error: null as Error | null,
  },
}))

const mockAddToast = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useProjects', () => ({
  useCreateProject: () => mockProjectMutations.create,
  useUpdateProject: () => mockProjectMutations.update,
  useDeleteProject: () => mockProjectMutations.remove,
  useProjectWorktreesSize: () => ({
    data: undefined,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useDeleteProjectWorktrees: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@/components/shared/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}))

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { manualQaEnabled: false, gitHookPolicy: 'validate_advisory' } }),
}))

vi.mock('../FolderPicker', () => ({
  FolderPicker: ({ open }: { open: boolean }) => (open ? <div>Folder Picker</div> : null),
}))

vi.mock('../AppearancePickers', () => ({
  EmojiPickerSection: () => <div>Emoji Picker</div>,
  ColorPickerSection: () => <div>Color Picker</div>,
}))

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  })

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe('ProjectForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    mockProjectMutations.create.mutate.mockReset()
    mockProjectMutations.update.mutate.mockReset()
    mockProjectMutations.remove.mutate.mockReset()
    mockProjectMutations.create.error = null
    mockProjectMutations.update.error = null
    mockProjectMutations.create.isPending = false
    mockProjectMutations.update.isPending = false
    mockProjectMutations.remove.isPending = false
    mockAddToast.mockReset()
  })

  it('shows the WSL mounted-drive warning returned by project path validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        isGit: true,
        status: 'valid',
        message: 'Git repository root selected',
        performanceWarning:
          'This project folder resolves to /mnt/d/work/app while LoopTroop is running in WSL. Windows-mounted drives can significantly degrade Git, scanning, and workflow performance. Prefer a copy under /home or another Linux filesystem path.',
      }),
    })))

    render(<ProjectForm onClose={vi.fn()} />, { wrapper: Wrapper })

    expect(screen.queryByRole('radio', { name: 'Inherit' })).not.toBeInTheDocument()
    const advancedButton = screen.getByRole('button', { name: /Advanced/ })
    expect(advancedButton.parentElement).toHaveClass('border-2')
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('radio', { name: 'Disabled' })).not.toBeInTheDocument()
    fireEvent.click(advancedButton)
    expect(advancedButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('link', { name: 'Open documentation for project Manual QA checkpoint' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    expect(screen.getByRole('radio', { name: 'Check' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Check' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('link', { name: 'Open documentation for project Git hook policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#git-hook-policy`,
    )

    fireEvent.change(screen.getByLabelText(/Project Name/i), { target: { value: 'Mounted Repo' } })
    fireEvent.change(screen.getByLabelText(/Short Name/i), { target: { value: 'MNT' } })
    fireEvent.change(screen.getByLabelText(/Project Folder/i), { target: { value: '/mnt/d/work/app' } })

    await waitFor(() => {
      expect(screen.getByText('WSL mounted-drive warning')).toBeInTheDocument()
    })

    expect(screen.getByText(/resolves to \/mnt\/d\/work\/app while LoopTroop is running in WSL/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }))
    expect(mockProjectMutations.create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ gitHookPolicy: null }),
      expect.any(Object),
    )
  })

  it('shows the project-local .looptroop path in edit mode', async () => {
    render(
      <ProjectForm
        onClose={vi.fn()}
        project={{
          id: 1,
          name: 'LoopTroop',
          shortname: 'LOOP',
          icon: '📦',
          color: '#3b82f6',
          folderPath: '/home/liviu/LoopTroop',
          profileId: null,
          councilMembers: null,
          maxIterations: null,
          perIterationTimeout: null,
          executionSetupTimeout: null,
          gitHookPolicy: null,
          councilResponseTimeout: null,
          minCouncilQuorum: null,
          interviewQuestions: null,
          ticketCounter: 4,
          createdAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        }}
      />, 
      { wrapper: Wrapper },
    )

    expect(screen.getByText('State Folder')).toBeInTheDocument()
    expect(screen.getByText('/home/liviu/LoopTroop/.looptroop')).toBeInTheDocument()

    fireEvent.focus(screen.getByRole('button', { name: 'State folder info' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent("LoopTroop keeps this project's local runtime state here.")
  })

  it('defaults existing state to restore and submits the restore action with saved editable settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        isGit: true,
        status: 'valid',
        scope: 'root',
        repoRoot: '/work/meili',
        hasLoopTroopState: true,
        existingProject: {
          name: 'MeiliSearch',
          shortname: 'MESE',
          icon: '🔎',
          color: '#a855f7',
          ticketCounter: 7,
          ticketCount: 7,
          activeTicketCount: 2,
          gitHookPolicy: 'use_native_hooks',
          manualQaOverride: true,
        },
      }),
    })))

    render(<ProjectForm onClose={vi.fn()} />, { wrapper: Wrapper })
    fireEvent.change(screen.getByLabelText(/Project Folder/i), { target: { value: '/work/meili' } })

    expect(await screen.findByText('Existing LoopTroop project detected')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Restore everything/i })).toBeChecked()
    await waitFor(() => {
      expect(screen.getByDisplayValue('MeiliSearch')).toBeInTheDocument()
      expect(screen.getByText('MESE')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText(/Short Name/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByRole('radio', { name: 'Run' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('7 tickets and all workflow/artifact data')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restore Project' }))

    expect(mockProjectMutations.create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MeiliSearch',
        shortname: 'MESE',
        folderPath: '/work/meili',
        existingStateAction: 'restore',
        gitHookPolicy: 'use_native_hooks',
        manualQaOverride: true,
      }),
      expect.any(Object),
    )
    mockProjectMutations.create.mutate.mock.calls[0]?.[1]?.onSuccess()
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Project restored from existing LoopTroop data.')
  })

  it('shows clear-ticket impact, confirms destruction, and submits clear_tickets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        isGit: true,
        status: 'valid',
        scope: 'root',
        repoRoot: '/work/meili',
        hasLoopTroopState: true,
        existingProject: {
          name: 'MeiliSearch',
          shortname: 'MESE',
          icon: '🔎',
          color: '#a855f7',
          ticketCounter: 7,
          ticketCount: 7,
          activeTicketCount: 2,
        },
      }),
    })))

    render(<ProjectForm onClose={vi.fn()} />, { wrapper: Wrapper })
    fireEvent.change(screen.getByLabelText(/Project Folder/i), { target: { value: '/work/meili' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Keep project settings, clear tickets/i }))

    expect(screen.getByText(/2 tickets are currently active and will be deleted/i)).toBeInTheDocument()
    expect(screen.getByText('Managed worktrees and saved OpenCode sessions')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Short Name/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Tickets & Attach' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('7 tickets will be deleted', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/including 2 active/i)).toBeInTheDocument()
    expect(screen.getByText(/Existing Git branches are not deleted/i)).toBeInTheDocument()
    expect(screen.getByText(/repository source files, commits, and remote branches are not changed/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Tickets & Attach' }))

    expect(mockProjectMutations.create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        shortname: 'MESE',
        existingStateAction: 'clear_tickets',
        manualQaOverride: null,
      }),
      expect.any(Object),
    )
    mockProjectMutations.create.mutate.mock.calls[0]?.[1]?.onSuccess()
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Project attached with its settings and a clean ticket list.')
  })

  it('unlocks the short name for start-fresh and submits only after confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        isGit: true,
        status: 'valid',
        scope: 'root',
        repoRoot: '/work/meili',
        hasLoopTroopState: true,
        existingProject: {
          name: 'MeiliSearch',
          shortname: 'MESE',
          icon: '🔎',
          color: '#a855f7',
          ticketCounter: 7,
          ticketCount: 7,
          activeTicketCount: 0,
        },
      }),
    })))

    render(<ProjectForm onClose={vi.fn()} />, { wrapper: Wrapper })
    fireEvent.change(screen.getByLabelText(/Project Folder/i), { target: { value: '/work/meili' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Start fresh/i }))

    const shortnameInput = screen.getByLabelText(/Short Name/i)
    expect(shortnameInput).toHaveValue('MESE')
    fireEvent.change(shortnameInput, { target: { value: 'NEW' } })
    expect(screen.getByText(/All tickets, artifacts, worktrees, and saved metadata/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start Fresh' }))
    expect(mockProjectMutations.create.mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('New project settings used')
    expect(screen.getByRole('dialog')).toHaveTextContent('NEW-1')

    fireEvent.click(screen.getByRole('button', { name: 'Start Fresh' }))
    expect(mockProjectMutations.create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        shortname: 'NEW',
        existingStateAction: 'start_fresh',
      }),
      expect.any(Object),
    )
    mockProjectMutations.create.mutate.mock.calls[0]?.[1]?.onSuccess()
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Fresh project created after removing existing LoopTroop state.')
  })

  it('keeps destructive confirmation open and disabled while submission is pending or fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        isGit: true,
        status: 'valid',
        scope: 'root',
        repoRoot: '/work/meili',
        hasLoopTroopState: true,
        existingProject: {
          name: 'MeiliSearch',
          shortname: 'MESE',
          icon: null,
          color: null,
          ticketCounter: 1,
          ticketCount: 1,
          activeTicketCount: 1,
        },
      }),
    })))

    const view = render(<ProjectForm onClose={vi.fn()} />, { wrapper: Wrapper })
    fireEvent.change(screen.getByLabelText(/Project Folder/i), { target: { value: '/work/meili' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Keep project settings, clear tickets/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear Tickets & Attach' }))

    mockProjectMutations.create.isPending = true
    view.rerender(<ProjectForm onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear Tickets & Attach' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    mockProjectMutations.create.isPending = false
    mockProjectMutations.create.error = new Error('Unable to clear project state')
    view.rerender(<ProjectForm onClose={vi.fn()} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Unable to clear project state', 5000)
  })
})
