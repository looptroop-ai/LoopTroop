import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBead, makeTicket } from '@/test/factories'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Ticket } from '@/hooks/useTickets'
import { useLogs } from '@/context/useLogContext'

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useTicketAction: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

vi.mock('@/context/useLogContext', () => ({
  useLogs: vi.fn(),
}))

vi.mock('../PhaseArtifactsPanel', () => ({
  PhaseArtifactsPanel: () => <div data-testid="phase-artifacts-panel" />,
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: () => <div data-testid="collapsible-log-section" />,
}))

vi.mock('../BeadDiffViewer', () => ({
  BeadDiffViewer: ({ beadId }: { beadId: string }) => <div data-testid="bead-diff-viewer">{beadId}</div>,
}))

vi.mock('../VerificationSummaryPanel', () => ({
  VerificationSummaryPanel: () => <div data-testid="verification-summary-panel" />,
}))

import { CodingView } from '../CodingView'

type CodingTestOverrides = Omit<Partial<Ticket>, 'runtime'> & {
  runtime?: Partial<Ticket['runtime']>
}

function renderCoding(overrides: CodingTestOverrides = {}) {
  const baseTicket = makeTicket({ status: 'CODING' })
  const ticket = makeTicket({
    ...baseTicket,
    ...overrides,
    runtime: {
      ...baseTicket.runtime,
      ...(overrides.runtime ?? {}),
    },
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CodingView ticket={ticket} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([]), { status: 200 }),
  )
  vi.mocked(useLogs).mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  fetchSpy.mockRestore()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('CodingView hover cards', () => {
  describe('PRD ref hover card', () => {
    it('renders PRD ref codes with cursor-help styling when bead has prdRefs', () => {
      renderCoding({
        runtime: {
          beads: [makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, prdRefs: ['E1', 'US1.1'] })],
        },
      })

      // Click the bead to expand details
      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      // PRD refs should be rendered as code elements with cursor-help
      const e1 = screen.getByText('E1')
      expect(e1.tagName).toBe('CODE')
      expect(e1.className).toContain('cursor-help')

      const us11 = screen.getByText('US1.1')
      expect(us11.tagName).toBe('CODE')
      expect(us11.className).toContain('cursor-help')
    })
  })

  describe('Label hover card', () => {
    it('renders labels as badges with cursor-help styling', () => {
      renderCoding({
        runtime: {
          beads: [makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, labels: ['frontend', 'auth'] })],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      const frontendEl = screen.getByText('frontend')
      expect(frontendEl).toBeTruthy()
      // cursor-help is on the parent <span> wrapper, not the Badge itself
      expect(frontendEl.parentElement!.className).toContain('cursor-help')

      const authEl = screen.getByText('auth')
      expect(authEl).toBeTruthy()
      expect(authEl.parentElement!.className).toContain('cursor-help')
    })
  })

  describe('Dependency bead hover card', () => {
    it('renders blocked_by dependency IDs with cursor-help styling', () => {
      renderCoding({
        runtime: {
          beads: [
            makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, dependencies: { blocked_by: ['bead-2'], blocks: [] } }),
            makeBead({ id: 'bead-2', title: 'Blocker Bead', status: 'done', iteration: 1 }),
          ],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      const depCode = screen.getByText(/bead-2/)
      expect(depCode.tagName).toBe('CODE')
      expect(depCode.className).toContain('cursor-help')
      expect(depCode.textContent).toBe('bead-2 (#2)')
    })

    it('renders blocks dependency IDs as well', () => {
      renderCoding({
        runtime: {
          beads: [
            makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, dependencies: { blocked_by: [], blocks: ['bead-3'] } }),
            makeBead({ id: 'bead-3', title: 'Downstream Bead', status: 'pending', iteration: 0 }),
          ],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      const depCode = screen.getByText(/bead-3/)
      expect(depCode.tagName).toBe('CODE')
      expect(depCode.className).toContain('cursor-help')
      expect(depCode.textContent).toBe('bead-3 (#2)')
    })
  })

  describe('Target file row', () => {
    it('shows a copy failure and clears it when retry succeeds', async () => {
      const writeText = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      renderCoding({ runtime: { beads: [makeBead({ title: 'Test Bead', status: 'in_progress', targetFiles: ['src/main.ts'] })] } })
      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))
      const button = screen.getByRole('button', { name: 'Copy path' })
      fireEvent.click(button)
      expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed')
      fireEvent.click(button)
      await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument() })
    })

    it('renders target files as code elements with copy button', () => {
      renderCoding({
        runtime: {
          beads: [makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, targetFiles: ['src/app.ts', 'src/utils.ts'] })],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      expect(screen.getByText('src/app.ts')).toBeTruthy()
      expect(screen.getByText('src/utils.ts')).toBeTruthy()

      // Copy buttons should exist (one per file)
      const copyButtons = screen.getAllByRole('button', { name: 'Copy path' })
      expect(copyButtons.length).toBe(2)
    })

    it('copies file path to clipboard when copy button is clicked', async () => {
      const writeTextSpy = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextSpy },
        writable: true,
        configurable: true,
      })

      renderCoding({
        runtime: {
          beads: [makeBead({ id: 'bead-1', title: 'Test Bead', status: 'in_progress', iteration: 1, targetFiles: ['src/main.ts'] })],
        },
      })

      fireEvent.click(screen.getByRole('button', { name: /Test Bead/ }))

      const copyBtn = screen.getByRole('button', { name: 'Copy path' })
      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(writeTextSpy).toHaveBeenCalledWith('src/main.ts')
      })
    })
  })
})
