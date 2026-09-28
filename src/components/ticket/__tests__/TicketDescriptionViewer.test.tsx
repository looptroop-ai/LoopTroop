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

  it('renders ordered lists, deeper headings, blockquotes, and horizontal rules', () => {
    const { container } = render(
      <TicketDescriptionViewer
        description={[
          '## Scope',
          '### Checks',
          '#### Details',
          '',
          '1. First ordered item',
          '2) Second ordered item',
          '',
          '> First cited line',
          '> Second cited line',
          'After the quotation.',
          '',
          '---',
        ].join('\n')}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Scope', level: 4 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Checks', level: 5 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Details', level: 6 })).toBeInTheDocument()
    const orderedList = screen.getByRole('list')
    expect(orderedList.tagName).toBe('OL')
    expect(orderedList).toHaveTextContent('First ordered item')
    expect(orderedList).toHaveTextContent('Second ordered item')
    expect(screen.getByText((_content, element) => element?.tagName === 'BLOCKQUOTE')).toHaveTextContent(
      'First cited lineSecond cited line',
    )
    expect(screen.getByText('After the quotation.')).toBeInTheDocument()
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('keeps incomplete inline Markdown visible as text and renders strikethrough', () => {
    const { container } = render(
      <TicketDescriptionViewer
        description={[
          'Unclosed `code marker',
          '[unfinished link label',
          '[unclosed target](https://example.com',
          '**unfinished emphasis',
          '~~removed text~~',
        ].join('\n')}
      />,
    )

    expect(container.textContent).toContain('Unclosed `code marker')
    expect(container.textContent).toContain('[unfinished link label')
    expect(container.textContent).toContain('[unclosed target](https://example.com')
    expect(container.textContent).toContain('**unfinished emphasis')
    expect(container.querySelector('code')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(screen.getByText('removed text').tagName).toBe('DEL')
  })

  it('parses escaped parentheses in link targets and renders malformed URLs as text', () => {
    render(
      <TicketDescriptionViewer
        description={String.raw`[escaped target](https://example.com/path\)segment)
[invalid target](https://[invalid)`}
      />,
    )

    expect(screen.getByRole('link', { name: 'escaped target' }).getAttribute('href')).toMatch(/^https:\/\/example\.com\//)
    expect(screen.getByText('invalid target').tagName).toBe('SPAN')
  })
})
