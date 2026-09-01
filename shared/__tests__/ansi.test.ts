import { describe, expect, it } from 'vitest'
import { stripAnsiSequences } from '../ansi'

const ESC = String.fromCodePoint(27)
const BELL = String.fromCodePoint(7)
const C1_CSI = String.fromCodePoint(155)
const C1_OSC = String.fromCodePoint(157)
const C1_ST = String.fromCodePoint(156)

describe('stripAnsiSequences', () => {
  it('leaves plain text alone', () => {
    expect(stripAnsiSequences('nothing to strip')).toBe('nothing to strip')
  })

  it('strips a 7-bit CSI colour sequence', () => {
    expect(stripAnsiSequences(`${ESC}[31mred${ESC}[39m`)).toBe('red')
  })

  it('strips an 8-bit C1 CSI sequence', () => {
    // The two server callers had a 7-bit-only stripper, so these survived into
    // bead failure notes.
    expect(stripAnsiSequences(`${C1_CSI}31mred${C1_CSI}39m`)).toBe('red')
  })

  it('strips a two-character ESC escape', () => {
    expect(stripAnsiSequences(`before${ESC}Mafter`)).toBe('beforeafter')
  })

  describe('OSC sequences', () => {
    it.each([
      ['BEL', `${ESC}]0;title${BELL}visible`],
      ['ESC backslash', `${ESC}]0;title${ESC}\\visible`],
      ['C1 ST', `${ESC}]0;title${C1_ST}visible`],
    ])('strips a 7-bit OSC terminated by %s', (_name, input) => {
      expect(stripAnsiSequences(input)).toBe('visible')
    })

    it.each([
      ['BEL', `${C1_OSC}0;title${BELL}visible`],
      ['ESC backslash', `${C1_OSC}0;title${ESC}\\visible`],
      ['C1 ST', `${C1_OSC}0;title${C1_ST}visible`],
    ])('strips an 8-bit OSC terminated by %s', (_name, input) => {
      expect(stripAnsiSequences(input)).toBe('visible')
    })

    it('stops at the first terminator instead of the last', () => {
      // A greedy body ran past the `ESC \` to the later BEL and deleted the
      // text in between: this returned 'tail' and ate a real line of output.
      const input = `${ESC}]0;first${ESC}\\ VISIBLE ${ESC}]0;second${BELL}tail`
      expect(stripAnsiSequences(input)).toBe(' VISIBLE tail')
    })

    it('does not keep an unterminated 8-bit introducer either', () => {
      // The 7-bit case is cleaned by the two-character escape rule below; the
      // C1 introducer had no equivalent and travelled into bead notes intact.
      expect(stripAnsiSequences(`${C1_OSC}0;never terminated`)).toBe('0;never terminated')
      // `C1_CSI` followed by a letter is a *complete* CSI sequence, so the
      // unterminated case needs a byte no CSI can end on.
      expect(stripAnsiSequences(`${C1_CSI}\nnever terminated`)).toBe('\nnever terminated')
    })

    it('does not eat the rest of the text after an unterminated OSC introducer', () => {
      // No terminator means no OSC match at all. The introducer is then removed
      // by the two-character escape rule and the payload stays visible, which is
      // the right way round: the alternative is losing everything that follows.
      expect(stripAnsiSequences(`${ESC}]0;never terminated`)).toBe('0;never terminated')
    })
  })

  it('strips a mixture in one pass', () => {
    const input = `${ESC}[1mbold${ESC}[0m ${ESC}]0;t${BELL}text ${C1_CSI}31mred`
    expect(stripAnsiSequences(input)).toBe('bold text red')
  })
})
