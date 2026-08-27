import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TicketDescriptionViewer } from '../TicketDescriptionViewer'

describe('TicketDescriptionViewer', () => {
  it('renders common ticket Markdown as read-only rich text', () => {
    render(
      <TicketDescriptionViewer
        description={[
          '# Acceptance',
          '',
          '**Need** *this* and `inline code`.',
          '',
          '- [x] Copy important context',
          '- Keep regular bullets',
          '',
          '| Field | Value |',
          '| --- | --- |',
          '| Status | Ready |',
          '',
          '```ts',
          'const ok = true',
          '```',
          '',
          '[LoopTroop](https://example.com/docs)',
        ].join('\n')}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Acceptance' })).toBeInTheDocument()
    expect(screen.getByText('Need').tagName).toBe('STRONG')
    expect(screen.getByText('this').tagName).toBe('EM')
    expect(screen.getByText('inline code').tagName).toBe('CODE')
    expect(screen.getByRole('checkbox', { name: 'Completed task' })).toBeChecked()
    expect(screen.getByText('Keep regular bullets')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Field' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Ready' })).toBeInTheDocument()
    expect(screen.getByText('const ok = true').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: 'LoopTroop' })).toHaveAttribute('href', 'https://example.com/docs')
  })

  it('keeps plain multiline text readable with line breaks', () => {
    const { container } = render(<TicketDescriptionViewer description={'First line\nSecond line'} />)

    expect(container.textContent).toContain('First line')
    expect(container.textContent).toContain('Second line')
    expect(container.querySelector('p br')).not.toBeNull()
  })

  it('does not inject pasted HTML or unsafe Markdown links', () => {
    const { container } = render(
      <TicketDescriptionViewer
        description={[
          '<script>alert("bad")</script>',
          '<a href="javascript:alert(1)">bad html link</a>',
          '[unsafe markdown link](javascript:alert(1))',
          '[safe link](https://example.com)',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(container.textContent).toContain('<script>alert("bad")</script>')
    expect(container.textContent).toContain('<a href="javascript:alert(1)">bad html link</a>')
    expect(screen.getByText('unsafe markdown link').tagName).toBe('SPAN')
    expect(screen.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com')
  })

  it('encodes validated link targets before putting DOM text in an href', () => {
    render(
      <TicketDescriptionViewer
        description={'[safe punctuation](https://example.com/path?q="value")'}
      />,
    )

    expect(screen.getByRole('link', { name: 'safe punctuation' })).toHaveAttribute(
      'href',
      'https://example.com/path?q=%22value%22',
    )
  })

  it('preserves existing percent escapes in validated link targets', () => {
    render(
      <TicketDescriptionViewer
        description={'[encoded path](https://example.com/already%20encoded%2Fpath?q=%E2%9C%93)'}
      />,
    )

    expect(screen.getByRole('link', { name: 'encoded path' })).toHaveAttribute(
      'href',
      'https://example.com/already%20encoded%2Fpath?q=%E2%9C%93',
    )
  })
})
