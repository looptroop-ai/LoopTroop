import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReleaseNotes } from '../ReleaseNotes'

/**
 * Shaped after a real release body produced by `scripts/print-release-notes.ts`
 * — bullets carrying bold and inline code, a heading, a fenced block, a link,
 * and the HTML comment markers the container section is wrapped in.
 */
const NOTES = [
  '- **Starting LoopTroop is one command.** `looptroop open` now starts the daemon.',
  '- An emergency release path that would have produced nothing is fixed.',
  '',
  '<!-- container:start -->',
  '### Container image',
  '',
  '```',
  'docker pull looptroopai/looptroop:0.5.5',
  '```',
  '',
  'See [Run it in a container](https://github.com/looptroop-ai/LoopTroop#run-it-in-a-container) for how.',
  '<!-- container:end -->',
].join('\n')

describe('ReleaseNotes', () => {
  it('renders bullets, bold, inline code, headings, fences and links as markup', () => {
    render(<ReleaseNotes notes={NOTES} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Starting LoopTroop is one command.').tagName).toBe('STRONG')
    expect(screen.getByText('looptroop open').tagName).toBe('CODE')
    expect(screen.getByText('Container image')).toBeInTheDocument()
    expect(screen.getByText('docker pull looptroopai/looptroop:0.5.5').tagName).toBe('CODE')

    const link = screen.getByRole('link', { name: 'Run it in a container' })
    expect(link).toHaveAttribute('href', 'https://github.com/looptroop-ai/LoopTroop#run-it-in-a-container')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('leaves the comment markers out of the rendered text', () => {
    const { container } = render(<ReleaseNotes notes={NOTES} />)

    expect(container.textContent).not.toContain('container:start')
    expect(container.textContent).not.toContain('<!--')
  })

  /** Release bodies are third-party text; a `javascript:` URL must not become a link. */
  it('renders a non-http link target as plain text', () => {
    render(<ReleaseNotes notes={'See [the notes](javascript:alert(1)) here.'} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/the notes/)).toBeInTheDocument()
  })

  it('shows the content of an unterminated fence rather than swallowing it', () => {
    render(<ReleaseNotes notes={'```\nnpm install -g looptroop'} />)

    expect(screen.getByText('npm install -g looptroop')).toBeInTheDocument()
  })
})
