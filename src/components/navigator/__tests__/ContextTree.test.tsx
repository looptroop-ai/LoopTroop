import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { ContextTree } from '../ContextTree'

describe('ContextTree', () => {
  it('shows Drafting PRD as two context parts', () => {
    renderWithProviders(<ContextTree selectedPhase="DRAFTING_PRD" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Allowed Context')).toBeInTheDocument()
    expect(screen.getByText('Part 1')).toBeInTheDocument()
    expect(screen.getByText(/Answering Skipped Questions/)).toBeInTheDocument()
    expect(screen.getByText('Part 2')).toBeInTheDocument()
    expect(screen.getByText(/Generating PRD Drafts/)).toBeInTheDocument()
    expect(screen.getAllByText('Relevant Files')).toHaveLength(2)
    expect(screen.getAllByText('Ticket Details')).toHaveLength(2)
    expect(screen.getByText('Interview Results')).toBeInTheDocument()
    expect(screen.getAllByText('Full Answers')).toHaveLength(2)
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('PRD Drafts')).toBeInTheDocument()
  })

  it('shows Beads coverage as coverage-only review (no expansion)', () => {
    renderWithProviders(<ContextTree selectedPhase="VERIFYING_BEADS_COVERAGE" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Allowed Context')).toBeInTheDocument()
    expect(screen.getByText('Coverage Review')).toBeInTheDocument()
    expect(screen.queryByText('Part 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Part 2')).not.toBeInTheDocument()
    expect(screen.queryByText(/Final Expansion/)).not.toBeInTheDocument()
    expect(screen.getByText('PRD')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('Semantic Blueprint')).toBeInTheDocument()
  })

  it('shows Expanding Beads as expansion step with beads plan output', () => {
    renderWithProviders(<ContextTree selectedPhase="EXPANDING_BEADS" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Expansion')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByLabelText('Execution-ready tasks for approval.')).toBeInTheDocument()
  })

  it('uses curated output labels for council drafting', () => {
    renderWithProviders(<ContextTree selectedPhase="COUNCIL_DELIBERATING" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Interview Drafts')).toBeInTheDocument()
    expect(screen.getByLabelText('Candidate question sets for voting.')).toBeInTheDocument()
    expect(screen.queryByText('Pull Request')).toBeNull()
  })

  it('shows the selected winner as the voting output', () => {
    renderWithProviders(<ContextTree selectedPhase="COUNCIL_VOTING_INTERVIEW" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Winning Draft')).toBeInTheDocument()
    expect(screen.getByLabelText('Selected draft used to build the interview.')).toBeInTheDocument()
    expect(screen.queryByText('Council Votes')).toBeNull()
  })

  it('shows the generated setup-plan candidate as the drafting output', () => {
    renderWithProviders(<ContextTree selectedPhase="GENERATING_EXECUTION_SETUP_PLAN" />)

    fireEvent.click(screen.getByRole('button', { name: /context & output/i }))

    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('Setup Plan Candidate')).toBeInTheDocument()
    expect(screen.getByLabelText('Generated readiness assessment and setup contract for approval.')).toBeInTheDocument()
  })
})
