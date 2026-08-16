import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AboutDialog } from '../AboutDialog'
import packageJson from '../../../../package.json'

vi.mock('@/hooks/useStartupStatus', () => ({
  useStartupStatus: () => ({
    data: {
      storage: {
        kind: 'restored',
        dbPath: '/home/liviu/.config/looptroop/app.sqlite',
        configDir: '/home/liviu/.config/looptroop',
        source: 'default',
        profileRestored: true,
        restoredProjectCount: 1,
        restoredProjects: [],
      },
      runtime: {
        isWsl: false,
        osLabel: 'Linux',
        appRoot: '/home/liviu/LoopTroop',
        appPathWarning: null,
      },
      ui: {
        restoreNotice: {
          shouldShow: false,
          dismissedAt: null,
        },
      },
    },
  }),
}))

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ],
  }),
}))

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({
    isLoading: false,
    data: {
      currentVersion: packageJson.version,
      latestVersion: '0.6.0',
      updateAvailable: true,
      checkedAt: '2026-08-16T08:00:00.000Z',
      installChannel: 'npm',
      upgradeCommand: 'npm install -g looptroop@latest',
      postUpgradeCommand: 'looptroop restart',
      release: {
        version: '0.6.0',
        name: 'LoopTroop 0.6.0',
        url: 'https://github.com/looptroop-ai/LoopTroop/releases/tag/v0.6.0',
        publishedAt: '2026-08-15T12:00:00.000Z',
        notes: 'Added release-aware update guidance.\n\nFixed stale daemon instructions.',
      },
    },
  }),
}))

describe('AboutDialog', () => {
  it('renders runtime and storage details with the professional labels', () => {
    render(<AboutDialog />)

    expect(screen.getByText('Runtime')).toBeInTheDocument()
    expect(screen.getByText('Operating System')).toBeInTheDocument()
    expect(screen.getByText('Linux')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('/home/liviu/.config/looptroop/app.sqlite')).toBeInTheDocument()
    expect(screen.getByText('/home/liviu/.config/looptroop')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('<repo>/.looptroop/')).toBeInTheDocument()
  })

  it('shows the available version, exact update steps, and release details', async () => {
    render(<AboutDialog />)

    expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument()
    expect(screen.getByText('v0.6.0')).toBeInTheDocument()
    expect(screen.getByText('npm install -g looptroop@latest')).toBeInTheDocument()
    expect(screen.getByText('looptroop restart')).toBeInTheDocument()

    const changelog = screen.getByRole('link', { name: /changelog/i })
    expect(changelog).toHaveAttribute('href', 'https://github.com/looptroop-ai/LoopTroop/releases/tag/v0.6.0')
    fireEvent.focus(changelog)

    expect(await screen.findByText(/Added release-aware update guidance/)).toBeInTheDocument()
  })
})
