import { afterEach, describe, expect, it } from 'vitest'
import { encode } from 'gpt-tokenizer'
import { TEST } from '../../test/factories'
import { buildMinimalContext, clearContextCache, contextCache } from '../contextBuilder'

afterEach(() => {
  clearContextCache(TEST.externalId)
  clearContextCache('1:cache-scope')
  clearContextCache('2:cache-scope')
})

describe('contextBuilder interview_qa context', () => {
  it('keeps PROM4 ticket details focused on the ticket requirement', () => {
    const parts = buildMinimalContext('interview_qa', {
      ticketId: TEST.externalId,
      title: 'Stabilize webhook retries',
      description: 'The sync webhook needs a clear retry and failure-handling strategy.',
      relevantFiles: '# Relevant Files',
      interview: 'questions:\n  - id: Q01',
      userAnswers: 'Q01: Existing retries are inconsistent.',
    })

    const ticketDetails = parts.find((part) => part.source === 'ticket_details')

    expect(ticketDetails?.content).toContain('## Primary User Requirement For This Ticket')
    expect(ticketDetails?.content).not.toContain('## User Interview Profile')
    expect(parts.map((part) => part.source)).toEqual(['ticket_details'])
  })

  it('scopes cached slices by project when callers provide an external id', () => {
    const firstProject = buildMinimalContext('interview_draft', {
      ticketId: 'cache-scope',
      projectId: 1,
      title: 'First project',
      description: 'First description',
      relevantFiles: 'first project files',
    })
    const secondProject = buildMinimalContext('interview_draft', {
      ticketId: 'cache-scope',
      projectId: 2,
      title: 'Second project',
      description: 'Second description',
      relevantFiles: 'second project files',
    })
    const firstProjectAgain = buildMinimalContext('interview_draft', {
      ticketId: 'cache-scope',
      projectId: 1,
      title: 'First project changed',
      description: 'First description changed',
      relevantFiles: 'new first project files',
    })

    expect(firstProject.find((part) => part.source === 'relevant_files')?.content).toBe('first project files')
    expect(secondProject.find((part) => part.source === 'relevant_files')?.content).toBe('second project files')
    expect(firstProjectAgain.find((part) => part.source === 'relevant_files')?.content).toBe('first project files')

    clearContextCache('cache-scope', 1)
    const refreshed = buildMinimalContext('interview_draft', {
      ticketId: 'cache-scope',
      projectId: 1,
      title: 'First project changed',
      description: 'First description changed',
      relevantFiles: 'new first project files',
    })
    const secondProjectStillCached = buildMinimalContext('interview_draft', {
      ticketId: 'cache-scope',
      projectId: 2,
      title: 'Second project changed',
      description: 'Second description changed',
      relevantFiles: 'new second project files',
    })

    expect(refreshed.find((part) => part.source === 'relevant_files')?.content).toBe('new first project files')
    expect(secondProjectStillCached.find((part) => part.source === 'relevant_files')?.content).toBe('second project files')
  })

  it('does not cache an unscoped external id', () => {
    const first = buildMinimalContext('interview_draft', {
      ticketId: 'unscoped-id',
      title: 'First project',
      description: 'First description',
      relevantFiles: 'first project files',
    })
    const second = buildMinimalContext('interview_draft', {
      ticketId: 'unscoped-id',
      title: 'Second project',
      description: 'Second description',
      relevantFiles: 'second project files',
    })

    expect(first.find((part) => part.source === 'relevant_files')?.content).toBe('first project files')
    expect(second.find((part) => part.source === 'relevant_files')?.content).toBe('second project files')
    expect([...contextCache.keys()].some((key) => key.includes('unscoped-id'))).toBe(false)
  })

  it('removes all expendable parts needed to meet the context budget', () => {
    const drafts = Array.from({ length: 5 }, (_, index) => `Draft ${index + 1}: ${'large draft content '.repeat(30_000)}`)
    const parts = buildMinimalContext('prd_vote', {
      ticketId: 'budget-test',
      title: 'Keep this requirement',
      description: 'This mandatory ticket requirement must remain in context.',
      drafts,
    })
    const tokenCount = encode(parts.map((part) => part.content).join('\n')).length

    expect(parts.some((part) => part.source === 'ticket_details')).toBe(true)
    expect(parts.filter((part) => part.source === 'draft').length).toBeLessThan(drafts.length)
    expect(tokenCount).toBeLessThanOrEqual(100_000)
  })

  it('keeps informational ticket provenance out of future prompt context', () => {
    const ticketState = {
      ticketId: TEST.externalId,
      title: 'Persist the selected filter',
      description: 'Remember the filter after reload.',
      manualQaOrigin: {
        sourceTicketExternalId: 'SOURCE-99',
        evidenceRefs: [{ originalName: 'private-evidence.png' }],
      },
    }

    const parts = buildMinimalContext('interview_qa', ticketState)
    const promptContext = parts.map((part) => part.content).join('\n')

    expect(promptContext).toContain('Persist the selected filter')
    expect(promptContext).toContain('Remember the filter after reload.')
    expect(promptContext).not.toContain('SOURCE-99')
    expect(promptContext).not.toContain('private-evidence.png')
  })

  it('keeps PRD coverage focused on winner full answers and PRD only', () => {
    const parts = buildMinimalContext('prd_coverage', {
      ticketId: TEST.externalId,
      interview: 'approved interview content',
      fullAnswers: ['winner full answers content'],
      prd: 'prd candidate content',
    })

    expect(parts.map((part) => part.source)).toEqual([
      'full_answers',
      'prd',
    ])
    expect(parts.map((part) => part.content).join('\n')).not.toContain('approved interview content')
  })

  it('keeps final test context to ticket details, PRD, beads, and retry notes', () => {
    const parts = buildMinimalContext('final_test', {
      ticketId: TEST.externalId,
      title: 'Final verification',
      description: 'Verify the implementation.',
      interview: 'approved interview content',
      prd: 'approved prd content',
      beads: 'approved beads content',
      finalTestNotes: ['final test retry note'],
    })

    expect(parts.map((part) => part.source)).toEqual([
      'ticket_details',
      'prd',
      'beads',
      'final_test_note',
    ])
    expect(parts.map((part) => part.content).join('\n')).not.toContain('approved interview content')
  })

  it('keeps pull request context to ticket details and PRD only', () => {
    const parts = buildMinimalContext('pull_request', {
      ticketId: TEST.externalId,
      title: 'Draft PR',
      description: 'Explain the finished change.',
      interview: 'approved interview content',
      prd: 'approved prd content',
      beads: 'approved beads content',
    })

    expect(parts.map((part) => part.source)).toEqual([
      'ticket_details',
      'prd',
    ])
    expect(parts.map((part) => part.content).join('\n')).not.toContain('approved interview content')
    expect(parts.map((part) => part.content).join('\n')).not.toContain('approved beads content')
  })

  it('keeps coding context to bead data and retry notes without inlining setup profile', () => {
    const parts = buildMinimalContext('coding', {
      ticketId: TEST.externalId,
      beadData: 'Bead A',
      beadNotes: ['prior coding retry'],
      executionSetupProfile: '{"artifact":"execution_setup_profile","status":"ready"}',
      executionSetupNotes: ['setup retry note'],
    })

    expect(parts.map((part) => part.source)).toEqual([
      'bead_data',
      'bead_note',
    ])
  })

  it('includes execution setup retry notes in the execution setup phase context', () => {
    const parts = buildMinimalContext('execution_setup', {
      ticketId: TEST.externalId,
      title: 'Prepare runtime',
      description: 'Initialize the environment.',
      relevantFiles: '# Relevant Files',
      prd: 'artifact: prd',
      beads: '{"id":"bead-1"}',
      executionSetupPlan: '{"artifact":"execution_setup_plan","status":"draft"}',
      executionSetupNotes: ['avoid writing to node_modules'],
    })

    expect(parts.map((part) => part.source)).toEqual([
      'ticket_details',
      'beads',
      'execution_setup_plan',
      'execution_setup_note',
    ])
  })

  it('includes setup-plan notes in the execution setup plan context', () => {
    const parts = buildMinimalContext('execution_setup_plan', {
      ticketId: TEST.externalId,
      title: 'Prepare runtime',
      description: 'Initialize the environment.',
      relevantFiles: '# Relevant Files',
      prd: 'artifact: prd',
      beads: '{"id":"bead-1"}',
      executionSetupProfile: '{"artifact":"execution_setup_profile","status":"ready"}',
      executionSetupPlanNotes: ['Use pnpm instead of npm.'],
    })

    expect(parts.map((part) => part.source)).toEqual([
      'ticket_details',
      'relevant_files',
      'prd',
      'beads',
      'execution_setup_profile',
      'execution_setup_plan_note',
    ])
  })
})
