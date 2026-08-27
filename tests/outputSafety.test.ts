import { describe, expect, it } from 'vitest'
import { doctorReportsInstallChannel, escapeMarkdownTableCell } from '../scripts/output-safety.ts'

describe('output safety helpers', () => {
  it('escapes every backslash before every Markdown table separator', () => {
    expect(escapeMarkdownTableCell(String.raw`first\|second|third\path`)).toBe(
      String.raw`first\\\|second\|third\\path`,
    )
  })

  it('keeps multiline metadata inside one Markdown table row', () => {
    expect(escapeMarkdownTableCell('first line\r\nsecond line\nthird line')).toBe(
      'first line second line third line',
    )
  })

  it('recognises only the selected install channel without compiling it as a regex', () => {
    const report = 'PASS install check: homebrew package detected\nPASS scoop is available'

    expect(doctorReportsInstallChannel(report, 'homebrew')).toBe(true)
    expect(doctorReportsInstallChannel(report, 'scoop')).toBe(false)
    expect(doctorReportsInstallChannel('uninstall homebrew', 'homebrew')).toBe(false)
    expect(doctorReportsInstallChannel('reinstall scoop', 'scoop')).toBe(false)
  })
})
