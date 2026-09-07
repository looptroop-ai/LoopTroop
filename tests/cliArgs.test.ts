import { describe, it, expect } from 'vitest'
import { ArgumentError, parseArgs, requireNoPositional, requirePositional } from '../scripts/cli-args.ts'

/**
 * Each of these was a real shape one of the release scripts accepted and acted
 * on. They matter because the arguments are assembled by a workflow from
 * expressions, so "the flag is there but its value is not" is not a typo
 * somebody makes once — it is what an expression expanding to nothing produces
 * every time.
 */
describe('parseArgs', () => {
  const schema = { out: 'value', asset: 'values', 'dry-run': 'switch' } as const

  it('reads values, repeated values, switches and positionals', () => {
    const parsed = parseArgs(
      ['looptroop-9.9.9.tgz', '--out', 'dist', '--asset', 'a.sh', '--asset', 'b.ps1', '--dry-run'],
      schema,
    )

    expect(parsed.positional).toEqual(['looptroop-9.9.9.tgz'])
    expect(parsed.value('out')).toBe('dist')
    expect(parsed.values('asset')).toEqual(['a.sh', 'b.ps1'])
    expect(parsed.switch('dry-run')).toBe(true)
  })

  it('reports a flag it was not told about, rather than dropping it', () => {
    // The old filter kept anything not starting with `--` as a positional and
    // discarded the rest, so a misspelled flag ran the default behaviour and
    // reported success.
    expect(() => parseArgs(['--dry-runn'], schema)).toThrow(ArgumentError)
    expect(() => parseArgs(['--dry-runn'], schema)).toThrow(/Unknown option --dry-runn/)
  })

  /**
   * `--out --foo` wrote the bundle to a directory literally named `--foo`.
   * `--asset` had a guard against this and `--out` did not, in the same file.
   */
  it('refuses a value that is another flag', () => {
    expect(() => parseArgs(['--out', '--dry-run'], schema)).toThrow(/--out needs a value, but is followed by --dry-run/)
  })

  it('refuses a value-taking flag at the end of the line', () => {
    expect(() => parseArgs(['--out'], schema)).toThrow(/--out needs a value, and is the last argument/)
  })

  /**
   * What a workflow produces from `--baseline "${{ github.event.before }}"`
   * when the expression is empty. Taking it silently fell back to the default,
   * which for `--baseline` moves the run into the other release lane.
   */
  it('refuses an empty value', () => {
    expect(() => parseArgs(['--out', ''], schema)).toThrow(/was given an empty one/)
  })

  it('refuses a non-repeatable flag given twice rather than picking one', () => {
    expect(() => parseArgs(['--out', 'a', '--out', 'b'], schema)).toThrow(/--out was given more than once/)
  })

  /**
   * A plain object inherits `constructor`, `toString` and friends, so a
   * `schema[name] === undefined` check found them *defined* and accepted
   * `--constructor` as a known flag — a malformed argument walking through the
   * check that exists to refuse malformed arguments.
   */
  it('does not treat an inherited property name as a known flag', () => {
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(() => parseArgs([`--${inherited}`, 'x'], schema)).toThrow(/Unknown option/)
    }
  })

  it('refuses a switch given twice, like every other non-repeatable flag', () => {
    expect(() => parseArgs(['--dry-run', '--dry-run'], schema)).toThrow(/--dry-run was given more than once/)
  })

  /**
   * `-o` is refused as an unknown option everywhere else, so taking it as a
   * *value* was the one place this parser read a flag as data.
   */
  it('refuses a single-dash token in value position', () => {
    expect(() => parseArgs(['--out', '-o'], schema)).toThrow(/--out needs a value, but is followed by -o/)
  })

  it('still accepts a lone dash as a value, which conventionally means stdin', () => {
    expect(parseArgs(['--out', '-'], schema).value('out')).toBe('-')
  })

  it('refuses any positional for a command that takes options only', () => {
    expect(() => requireNoPositional(parseArgs(['stray'], schema))).toThrow(/Unexpected argument "stray"/)
    expect(() => requireNoPositional(parseArgs(['--dry-run'], schema))).not.toThrow()
  })

  it('accepts the equals form, which is the only way to pass a value starting with dashes', () => {
    const parsed = parseArgs(['--out=--weird-but-mine'], schema)

    expect(parsed.value('out')).toBe('--weird-but-mine')
  })

  it('refuses a value handed to a switch', () => {
    expect(() => parseArgs(['--dry-run=yes'], schema)).toThrow(/--dry-run takes no value/)
  })

  it('takes everything after -- as positional', () => {
    const parsed = parseArgs(['--dry-run', '--', '--out', 'not-a-flag'], schema)

    expect(parsed.positional).toEqual(['--out', 'not-a-flag'])
    expect(parsed.value('out')).toBeNull()
    expect(parsed.switch('dry-run')).toBe(true)
  })

  it('reports a single-dash argument as an option rather than a positional', () => {
    expect(() => parseArgs(['-o', 'dist'], schema)).toThrow(/spelled with two dashes/)
  })

  it('leaves an absent flag absent rather than guessing', () => {
    const parsed = parseArgs([], schema)

    expect(parsed.value('out')).toBeNull()
    expect(parsed.values('asset')).toEqual([])
    expect(parsed.switch('dry-run')).toBe(false)
  })

  it('checks the positional count', () => {
    const parsed = parseArgs(['one', 'two'], schema)

    expect(requirePositional(parsed, 2, 'usage')).toEqual(['one', 'two'])
    expect(() => requirePositional(parsed, 1, 'usage')).toThrow(/usage/)
  })
})
