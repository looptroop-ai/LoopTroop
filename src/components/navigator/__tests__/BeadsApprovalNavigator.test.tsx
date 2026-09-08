import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TEST } from '@/test/factories'
import { renderWithProviders, createTestQueryClient } from '@/test/renderHelpers'
import { BeadsApprovalNavigator } from '../BeadsApprovalNavigator'

function renderNavigator(beads: unknown) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(['artifact', TEST.ticketId, 'beads'], beads)

  return renderWithProviders(<BeadsApprovalNavigator ticketId={TEST.ticketId} />, { queryClient })
}

describe('BeadsApprovalNavigator', () => {
  it('lists beads with their blocked-by counts', async () => {
    renderNavigator([
      { id: 'B-1', title: 'First bead', dependencies: { blocked_by: ['B-0'] } },
      { id: 'B-2', title: 'Second bead' },
    ])

    await waitFor(() => {
      expect(screen.getByText(/First bead/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Second bead/)).toBeInTheDocument()
    expect(screen.getByText('1 dep')).toBeInTheDocument()
  })

  /**
   * `server/routes/beads.ts` returns each JSONL line as parsed JSON with no
   * shape check, so a stored `null` or a bare number reaches this component.
   *
   * The outline drops them, because the artifact view drops them: the focus
   * anchors are positions in that filtered list, so a surface that numbered the
   * unfiltered array would send a click to the wrong bead. It briefly did —
   * filtering was added to the artifact parser alone.
   */
  it('drops entries that are not beads, and numbers what is left', async () => {
    renderNavigator([null, 42, 'nope', { id: 'B-1', title: 'Real bead' }])

    await waitFor(() => {
      expect(screen.getByText(/Real bead/)).toBeInTheDocument()
    })
    // The one real bead is #1, matching the `bead-0` anchor the viewer renders.
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.queryByText(/Bead 1|Bead 2|Bead 3/)).not.toBeInTheDocument()
  })

  /**
   * `blocked_by` is checked for being an array rather than merely having a
   * `length`: a string would otherwise report its character count as a
   * dependency count.
   */
  it('does not count a string blocked_by as dependencies', async () => {
    renderNavigator([{ id: 'B-1', title: 'Only bead', dependencies: { blocked_by: 'B-0' } }])

    await waitFor(() => {
      expect(screen.getByText(/Only bead/)).toBeInTheDocument()
    })
    // 'B-0'.length is 3, so the old `?.length ?? 0` read rendered "3 deps".
    expect(screen.queryByText(/deps?$/)).not.toBeInTheDocument()
  })

  it('numbers the surviving beads so the outline and the artifact view agree', async () => {
    renderNavigator([{ id: 'B-1', title: 'First' }, null, { id: 'B-2', title: 'Second' }])

    await waitFor(() => {
      expect(screen.getByText(/Second/)).toBeInTheDocument()
    })
    // Second is #2, not #3: the viewer renders it at `bead-1`.
    expect(screen.getByText('#2')).toBeInTheDocument()
    expect(screen.queryByText('#3')).not.toBeInTheDocument()
  })

  it('tolerates a non-object dependencies field', async () => {
    renderNavigator([{ id: 'B-1', title: 'Only bead', dependencies: 'nonsense' }])

    await waitFor(() => {
      expect(screen.getByText(/Only bead/)).toBeInTheDocument()
    })
  })
})
