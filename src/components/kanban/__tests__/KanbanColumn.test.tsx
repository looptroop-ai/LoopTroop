import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UIProvider } from '@/context/UIContext'
import type { Project } from '@/hooks/useProjects'
import { makeTicket } from '@/test/factories'
import { ANY_TICKET_CARD_LABEL, ticketCardLabel } from '@/test/ticketCardQueries'
import { KanbanColumn } from '../KanbanColumn'

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

function makeCompletedTickets(count: number) {
  return Array.from({ length: count }, (_, index) => makeTicket({
    id: `1:TEST-${index + 1}`,
    externalId: `TEST-${index + 1}`,
    title: `Ticket ${index + 1}`,
    status: 'COMPLETED',
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
  }))
}

describe('KanbanColumn', () => {
  it('shows a detailed tooltip for the column header', async () => {
    render(
      <TooltipProvider>
        <UIProvider>
          <KanbanColumn
            column={{
              id: 'needs_input',
              title: 'Needs Input',
              description: 'Waiting for user',
              tooltip: 'Tickets paused because LoopTroop needs a human action before it can continue.',
            }}
            tickets={[]}
            projectMap={new Map<number, Project>()}
          />
        </UIProvider>
      </TooltipProvider>,
    )

    fireEvent.focus(screen.getByText('Needs Input'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Tickets paused because LoopTroop needs a human action before it can continue.',
    )
  })

  it('lets you jump to a page by editing the current page number', () => {
    render(
      <TooltipProvider>
        <UIProvider>
          <KanbanColumn
            column={{
              id: 'done',
              title: 'Done',
              description: 'Completed tickets',
              tooltip: 'Terminal tickets that no longer advance automatically.',
            }}
            tickets={makeCompletedTickets(31)}
            projectMap={new Map<number, Project>()}
          />
        </UIProvider>
      </TooltipProvider>,
    )

    const pageInput = screen.getByRole('textbox', { name: /done current page/i })

    expect(pageInput).toHaveValue('1')
    expect(screen.getByLabelText(ticketCardLabel('TEST-31'))).toBeInTheDocument()

    fireEvent.change(pageInput, { target: { value: '3abc' } })

    expect(pageInput).toHaveValue('3')

    fireEvent.blur(pageInput)

    expect(pageInput).toHaveValue('3')
    expect(screen.getByLabelText(ticketCardLabel('TEST-1'))).toBeInTheDocument()
    expect(screen.queryByLabelText(ticketCardLabel('TEST-31'))).not.toBeInTheDocument()
    expect(screen.getByText('of 3')).toBeInTheDocument()
  })

  it('navigates pages, clamps entered page numbers, and resets after its inputs change', () => {
    const tickets = makeCompletedTickets(31)
    const column = {
      id: 'done',
      title: 'Done',
      description: 'Completed tickets',
      tooltip: 'Terminal tickets that no longer advance automatically.',
    } as const
    const renderColumn = (resetKey: string, visibleTickets = tickets) => (
      <TooltipProvider>
        <UIProvider>
          <KanbanColumn
            column={column}
            tickets={visibleTickets}
            projectMap={new Map<number, Project>()}
            resetKey={resetKey}
          />
        </UIProvider>
      </TooltipProvider>
    )
    const { rerender } = render(renderColumn('initial'))
    const pageInput = screen.getByRole('textbox', { name: /done current page/i })
    const controls = within(screen.getByText('Page').parentElement!.parentElement!)
    const pageButtons = controls.getAllByRole('button')
    const previousPage = pageButtons[0]!
    const nextPage = pageButtons[1]!

    expect(previousPage).toBeDisabled()
    fireEvent.click(nextPage)
    expect(pageInput).toHaveValue('2')
    expect(screen.getByLabelText(ticketCardLabel('TEST-16'))).toBeInTheDocument()
    expect(previousPage).toBeEnabled()

    pageInput.focus()
    fireEvent.change(pageInput, { target: { value: '99' } })
    fireEvent.keyDown(pageInput, { key: 'Enter' })
    expect(pageInput).toHaveValue('3')
    expect(screen.getByLabelText(ticketCardLabel('TEST-1'))).toBeInTheDocument()
    expect(nextPage).toBeDisabled()

    fireEvent.click(previousPage)
    pageInput.focus()
    fireEvent.change(pageInput, { target: { value: '0' } })
    fireEvent.blur(pageInput)
    expect(pageInput).toHaveValue('1')
    expect(screen.getByLabelText(ticketCardLabel('TEST-31'))).toBeInTheDocument()

    fireEvent.click(nextPage)
    pageInput.focus()
    fireEvent.change(pageInput, { target: { value: '' } })
    fireEvent.blur(pageInput)
    expect(pageInput).toHaveValue('2')

    pageInput.focus()
    fireEvent.change(pageInput, { target: { value: '1' } })
    fireEvent.keyDown(pageInput, { key: 'Escape' })
    expect(pageInput).toHaveValue('2')
    expect(screen.getByLabelText(ticketCardLabel('TEST-16'))).toBeInTheDocument()

    rerender(renderColumn('tickets-changed', tickets.slice(0, 30)))
    expect(pageInput).toHaveValue('1')
    expect(screen.getByLabelText(ticketCardLabel('TEST-30'))).toBeInTheDocument()
  })

  it('marks display-only mock ticket IDs on cards', () => {
    const ticket = makeTicket({
      externalId: 'TEST-99',
      isDisplayOnlyMock: true,
      title: 'Mock workflow sample',
      status: 'DRAFT',
    })

    render(
      <TooltipProvider>
        <UIProvider>
          <KanbanColumn
            column={{
              id: 'todo',
              title: 'To Do',
              description: 'Backlog',
              tooltip: 'Tickets that have not started yet.',
            }}
            tickets={[ticket]}
            projectMap={new Map<number, Project>()}
          />
        </UIProvider>
      </TooltipProvider>,
    )

    expect(screen.getByLabelText(ticketCardLabel('TEST-99 mock demo ticket'))).toBeInTheDocument()
    expect(screen.getByLabelText('TEST-99 mock demo ticket')).toHaveTextContent('TEST-99(M)')
  })

  it('sorts tickets by different criteria correctly', () => {
    const ticketA = makeTicket({
      id: '1:A',
      externalId: 'A',
      title: 'Zeta ticket',
      priority: 3,
      createdAt: '2026-06-04T12:00:00.000Z',
      updatedAt: '2026-06-01T13:00:00.000Z',
    })
    const ticketB = makeTicket({
      id: '1:B',
      externalId: 'B',
      title: 'Alpha ticket',
      priority: 1,
      createdAt: '2026-06-02T12:00:00.000Z',
      updatedAt: '2026-06-02T13:00:00.000Z',
    })
    const ticketC = makeTicket({
      id: '1:C',
      externalId: 'C',
      title: 'Beta ticket',
      priority: 2,
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-03T13:00:00.000Z',
    })
    const ticketD = makeTicket({
      id: '1:D',
      externalId: 'D',
      title: 'Delta ticket',
      priority: 2,
      createdAt: '2026-06-03T12:00:00.000Z',
      updatedAt: '2026-06-04T13:00:00.000Z',
    })

    const ticketsList = [ticketA, ticketB, ticketC, ticketD]

    const { rerender } = render(
      <TooltipProvider>
        <UIProvider>
          <KanbanColumn
            column={{
              id: 'todo',
              title: 'To Do',
              description: 'Backlog',
              tooltip: 'Tooltip text',
            }}
            tickets={ticketsList}
            projectMap={new Map<number, Project>()}
            sortBy="updatedAt_desc"
          />
        </UIProvider>
      </TooltipProvider>,
    )

    const sortCases: Array<[string, string[]]> = [
      ['updatedAt_desc', ['Delta ticket', 'Beta ticket', 'Alpha ticket', 'Zeta ticket']],
      ['updatedAt_asc', ['Zeta ticket', 'Alpha ticket', 'Beta ticket', 'Delta ticket']],
      ['createdAt_desc', ['Zeta ticket', 'Delta ticket', 'Alpha ticket', 'Beta ticket']],
      ['createdAt_asc', ['Beta ticket', 'Alpha ticket', 'Delta ticket', 'Zeta ticket']],
      ['priority_asc', ['Alpha ticket', 'Delta ticket', 'Beta ticket', 'Zeta ticket']],
      ['priority_desc', ['Zeta ticket', 'Delta ticket', 'Beta ticket', 'Alpha ticket']],
      ['title_asc', ['Alpha ticket', 'Beta ticket', 'Delta ticket', 'Zeta ticket']],
      ['title_desc', ['Zeta ticket', 'Delta ticket', 'Beta ticket', 'Alpha ticket']],
    ]

    for (const [sortBy, expectedTitles] of sortCases) {
      rerender(
        <TooltipProvider>
          <UIProvider>
            <KanbanColumn
              column={{
                id: 'todo',
                title: 'To Do',
                description: 'Backlog',
                tooltip: 'Tooltip text',
              }}
              tickets={ticketsList}
              projectMap={new Map<number, Project>()}
              sortBy={sortBy}
            />
          </UIProvider>
        </TooltipProvider>,
      )

      const renderedCardTitles = screen.getAllByRole('button', { name: ANY_TICKET_CARD_LABEL })
        .map(el => el.textContent)
      expect(renderedCardTitles).toEqual(expectedTitles)
    }
  })
})
