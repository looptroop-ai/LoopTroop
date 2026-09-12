import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AIQuestionContext } from '@/context/aiQuestionContextDef'
import { UIProvider } from '@/context/UIContext'
import { createAiQuestionContextStub } from '@/test/aiQuestionContext'
import { makeTicket } from '@/test/factories'
import { renderWithProviders } from '@/test/renderHelpers'
import { TicketCard } from '../TicketCard'
import { ProgressRing } from '../ProgressRing'

it('keeps each ring gradient distinct and stable across progress updates', () => {
  const rings = (percent: number, gradientId?: string) => <>
    <ProgressRing percent={percent} gradientId={gradientId} />
    <ProgressRing percent={percent} />
  </>
  const { container, rerender } = render(rings(10))
  const ids = () => Array.from(container.querySelectorAll('linearGradient'), element => element.id)
  const initialIds = ids()
  expect(new Set(initialIds).size).toBe(2)
  rerender(rings(50))
  expect(ids()).toEqual(initialIds)
  expect(Array.from(container.querySelectorAll('circle[stroke^="url"]'), element => element.getAttribute('stroke')))
    .toEqual(initialIds.map(id => `url(#${id})`))
  rerender(rings(75, 'custom-gradient'))
  expect(ids()).toEqual(['custom-gradient', initialIds[1]])
})

function renderCard(ticket: ReturnType<typeof makeTicket>) {
  return renderWithProviders(
    <AIQuestionContext.Provider value={createAiQuestionContextStub()}>
      <UIProvider>
        <TicketCard
          ticket={ticket}
          projectColor="#2563eb"
          projectIcon="T"
          projectName="TestProject"
        />
      </UIProvider>
    </AIQuestionContext.Provider>,
  )
}

describe('TicketCard progress', () => {
  it('uses runtime bead completion when top-level progress fields are absent', () => {
    const base = makeTicket()
    renderCard(makeTicket({
      status: 'CODING',
      totalBeads: null,
      percentComplete: null,
      runtime: {
        ...base.runtime,
        currentBead: 3,
        completedBeads: 2,
        totalBeads: 5,
        percentComplete: 40,
        eta: { bestMs: 600000, likelyMs: 900000, worstMs: 1500000, basis: 'current' },
      },
    }))

    expect(screen.getByText(/Implementing \(Bead 3\/5\)/)).toBeInTheDocument()
    expect(screen.getByText(/Implementing \(Bead 3\/5\)/).parentElement).toHaveAttribute('style', expect.stringContaining('40%'))
    expect(screen.getByText('~15m')).toBeInTheDocument()
  })
})
