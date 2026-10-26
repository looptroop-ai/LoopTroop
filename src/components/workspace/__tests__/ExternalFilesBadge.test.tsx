import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExternalFilesBadge } from '../ExternalFilesBadge'

describe('ExternalFilesBadge', () => {
  it('does not mark repository targets or a deliberately empty target list', () => {
    const { rerender } = render(<ExternalFilesBadge targetFiles={['src/example.txt', 'docs/../notes.md']} />)
    expect(screen.queryByText('External files')).not.toBeInTheDocument()
    rerender(<ExternalFilesBadge targetFiles={[]} />)
    expect(screen.queryByText('External files')).not.toBeInTheDocument()
  })

  it('uses server-resolved external symlinks without retaining warnings for removed targets', () => {
    const { rerender } = render(<ExternalFilesBadge targetFiles={['linked/new.txt']} externalTargetFiles={['linked/new.txt']} />)
    expect(screen.getByRole('note', { name: 'External files: linked/new.txt' })).toBeInTheDocument()
    rerender(<ExternalFilesBadge targetFiles={['src/local.txt']} externalTargetFiles={['linked/new.txt']} />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it.each(['/home/user/config.json', 'C:\\Users\\user\\config.json', '../shared/config.json', '~/config.json'])(
    'identifies external target %s with accessible text and its unchanged path', (externalPath) => {
      render(<ExternalFilesBadge targetFiles={['src/example.txt', externalPath]} />)
      const badge = screen.getByRole('note', { name: `External files: ${externalPath}` })
      expect(badge).toHaveTextContent('External files')
      expect(badge).toHaveAttribute('aria-label', `External files: ${externalPath}`)
      expect(badge).toHaveAttribute('title', `Targets outside the repository:\n${externalPath}`)
      expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    },
  )
})
