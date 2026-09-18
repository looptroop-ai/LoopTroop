import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteWorktreesDialog } from '../DeleteWorktreesDialog'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), addToast: vi.fn() }))
vi.mock('@/hooks/useProjects', () => ({
  useProjectWorktreesSize: () => ({ data: undefined, isFetching: false, refetch: vi.fn() }),
  useDeleteProjectWorktrees: () => ({ mutate: mocks.mutate, isPending: false }),
}))
vi.mock('@/components/shared/useToast', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}))

describe('Free Disk Space results', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps skipped worktrees and their reasons visible after partial cleanup', () => {
    const onClose = vi.fn()
    mocks.mutate.mockImplementation((_id, options) => options.onSuccess({
      success: true,
      freedBytes: 1024,
      skipped: [{ externalId: 'TEST-1', reason: 'Ignored file: .env' }],
    }))
    render(<DeleteWorktreesDialog open onClose={onClose} projectId={1} projectName="Project" />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktrees' }))

    expect(screen.getByRole('status')).toHaveTextContent('Freed 1.00 KB')
    expect(screen.getByRole('status')).toHaveTextContent('TEST-1: Ignored file: .env')
    expect(onClose).not.toHaveBeenCalled()
    expect(mocks.addToast).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Close', { selector: 'button' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes and reports the freed space when every worktree was removed', () => {
    const onClose = vi.fn()
    mocks.mutate.mockImplementation((_id, options) => options.onSuccess({
      success: true, freedBytes: 1024, skipped: [],
    }))
    render(<DeleteWorktreesDialog open onClose={onClose} projectId={1} projectName="Project" />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktrees' }))

    expect(mocks.addToast).toHaveBeenCalledWith('success', 'Worktrees deleted. Freed 1.00 KB.')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
