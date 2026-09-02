import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GIT_CHECK_DEBOUNCE_MS } from '@/lib/constants'
import { FolderPicker } from '../FolderPicker'

function lsBody(currentPath: string, dirs: string[] = []) {
  return {
    currentPath,
    parentPath: '/',
    dirs: dirs.map((name) => ({ name, path: `${currentPath}/${name}` })),
  }
}

describe('FolderPicker', () => {
  let pending: Map<string, Array<(body: unknown) => void>>

  beforeEach(() => {
    pending = new Map()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      return new Promise<Response>((resolve) => {
        const queue = pending.get(url) ?? []
        queue.push((body) => resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })))
        pending.set(url, queue)
      })
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function settle(url: string, body: unknown) {
    const queue = pending.get(url)
    if (!queue?.length) throw new Error(`No pending request for ${url}`)
    const resolve = queue.shift()!
    await act(async () => {
      resolve(body)
    })
  }

  it('ignores a git verdict for a folder the user has already navigated away from', async () => {
    // Both requests are debounced but neither was cancelled, so a slow git check
    // for the previous folder could land last and decide whether "Select This
    // Folder" is enabled for the folder now on screen.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <TooltipProvider>
        <FolderPicker open onClose={() => undefined} onSelect={() => undefined} initialPath="/slow" />
      </TooltipProvider>,
    )

    await waitFor(() => expect(pending.get('/api/projects/ls?path=%2Fslow')?.length).toBe(1))
    await settle('/api/projects/ls?path=%2Fslow', lsBody('/slow', ['inner']))

    // The first git check goes out while the user is still looking at /slow.
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_CHECK_DEBOUNCE_MS) })
    expect(pending.get('/api/projects/check-git?path=%2Fslow')?.length).toBe(1)

    // They then open a subdirectory, whose listing and git check both answer first.
    fireEvent.click(screen.getByText('inner'))
    await waitFor(() => expect(pending.get('/api/projects/ls?path=%2Fslow%2Finner')?.length).toBe(1))
    await settle('/api/projects/ls?path=%2Fslow%2Finner', lsBody('/slow/inner'))
    await act(async () => { await vi.advanceTimersByTimeAsync(GIT_CHECK_DEBOUNCE_MS) })
    await settle('/api/projects/check-git?path=%2Fslow%2Finner', {
      isGit: false,
      status: 'invalid',
      message: 'inner is not a repository',
    })

    expect(await screen.findByText('inner is not a repository')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Select This Folder/i })).toBeDisabled()

    // Now the superseded verdict lands. It must not decide anything.
    await settle('/api/projects/check-git?path=%2Fslow', {
      isGit: true,
      status: 'valid',
      message: 'slow is a repository',
    })

    expect(screen.getByText('inner is not a repository')).toBeInTheDocument()
    expect(screen.queryByText('slow is a repository')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Select This Folder/i })).toBeDisabled()
  })
})
