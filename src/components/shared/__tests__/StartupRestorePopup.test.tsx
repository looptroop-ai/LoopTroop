import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartupStatus } from '@/hooks/useStartupStatus'
import { StartupRestorePopup } from '../StartupRestorePopup'

const mockState = vi.hoisted(() => ({
  addToast: vi.fn(),
  dismiss: { mutate: vi.fn(), isPending: false },
}))

vi.mock('@/components/shared/useToast', () => ({
  useToast: () => ({ addToast: mockState.addToast }),
}))

vi.mock('@/hooks/useStartupStatus', () => ({
  useDismissStartupRestoreNotice: () => mockState.dismiss,
}))

afterEach(cleanup)

const startupStatus: StartupStatus = {
  storage: {
    kind: 'restored',
    dbPath: '/tmp/looptroop/app.sqlite',
    configDir: '/tmp/looptroop',
    source: 'default',
    profileRestored: true,
    restoredProjectCount: 2,
    restoredProjects: [
      { name: 'Alpha', shortname: 'ALP', folderPath: '/work/alpha' },
      { name: 'Beta', shortname: 'BET', folderPath: '/work/beta' },
    ],
  },
  runtime: { isWsl: false, osLabel: 'Linux', appRoot: '/work/looptroop', appPathWarning: null },
  ui: { restoreNotice: { shouldShow: true, dismissedAt: null } },
}

describe('StartupRestorePopup', () => {
  it('explains why saved data was found and keeps details and Continue reachable', () => {
    render(<StartupRestorePopup open startupStatus={startupStatus} />)

    const dialog = screen.getByRole('dialog', { name: 'Your saved profile and 2 projects are ready.' })
    const [header, details, footer] = Array.from(dialog.children)

    expect(screen.getByText(/checks its local database for a saved profile or project/i)).toBeInTheDocument()
    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto', 'flex', 'flex-col')
    expect(header).toHaveClass('shrink-0')
    expect(details).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    expect(footer).toHaveClass('shrink-0')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  it('keeps the one-project headline grammatical', () => {
    render(
      <StartupRestorePopup
        open
        startupStatus={{
          ...startupStatus,
          storage: { ...startupStatus.storage, profileRestored: false, restoredProjectCount: 1, restoredProjects: [startupStatus.storage.restoredProjects[0]!] },
        }}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Your saved project is ready.' })).toBeInTheDocument()
  })
})
