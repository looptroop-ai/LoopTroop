/**
 * One argument parser for the release and packaging scripts.
 *
 * Each of them used to read its own arguments by hand, with `indexOf` and a
 * filter for anything not starting with `--`, and each got a different subset
 * of the same problems wrong. What they had in common is that a *malformed*
 * invocation read as a valid one:
 *
 *   - An unknown flag was silently dropped by the positional filter, so a typo
 *     in a workflow ran the default behaviour and reported success.
 *   - A value-taking flag at the end of the line took `undefined` and fell back
 *     to its default, so a truncated `--baseline` argument flipped release
 *     gating from compare to defer.
 *   - A value-taking flag followed by another flag took *that flag* as its
 *     value, so `--out --foo` wrote to a file literally named `--foo`.
 *
 * None of those is theoretical for arguments assembled by a shell in a workflow
 * from an expression that can expand to nothing. So this refuses all three, and
 * every caller declares the set it accepts.
 *
 * Deliberately not a dependency. These scripts run under bare `node` in jobs
 * that do not `npm ci` — the one that drafts a release holds `contents: write`
 * and must not run third-party install scripts — so anything they import has to
 * be in this repository.
 */

/**
 * What a flag takes.
 *
 * `values` is the repeatable form. `value` is not repeatable on purpose: a flag
 * given twice is a caller that believes something this parser cannot honour,
 * and picking either occurrence would be a guess.
 */
export type FlagKind = 'switch' | 'value' | 'values'

export interface ParsedArgs {
  /** Positional arguments, in the order they were given. */
  positional: string[]
  /** Whether a `switch` flag was given. */
  switch: (name: string) => boolean
  /** A `value` flag's value, or null when it was not given. */
  value: (name: string) => string | null
  /** Every value of a `values` flag, in order. */
  values: (name: string) => string[]
}

/** Thrown for a malformed command line, so each caller can report it its own way. */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

/**
 * Reads `argv` against `schema`, or throws.
 *
 * `--name=value` is accepted alongside `--name value`, and is the one form that
 * can pass a value beginning with `--`, since there is then nothing to be
 * ambiguous about. `--` ends the options and makes everything after it
 * positional.
 */
export function parseArgs(argv: string[], schema: Record<string, FlagKind>): ParsedArgs {
  const positional: string[] = []
  const switches = new Set<string>()
  const singles = new Map<string, string>()
  const repeated = new Map<string, string[]>()

  const kindOf = (name: string): FlagKind => {
    // `Object.hasOwn`, not `schema[name] === undefined`. A plain object inherits
    // `constructor`, `toString`, `hasOwnProperty` and friends, so `--constructor`
    // and `--__proto__` read back as *defined* and were accepted as known flags
    // — a malformed argument getting past the check whose only job is to refuse
    // malformed arguments.
    if (!Object.hasOwn(schema, name)) {
      throw new ArgumentError(`Unknown option --${name}. Accepted: ${Object.keys(schema).map((known) => `--${known}`).join(', ') || '(none)'}.`)
    }
    return schema[name]!
  }

  const record = (name: string, kind: FlagKind, value: string) => {
    // An empty value is "no value" wearing a token. A workflow that interpolates
    // an expression which expanded to nothing produces exactly this, and taking
    // it would be the same silent default the explicit forms below refuse.
    if (value === '') throw new ArgumentError(`--${name} needs a value, and was given an empty one.`)
    if (kind === 'values') {
      repeated.set(name, [...(repeated.get(name) ?? []), value])
      return
    }
    if (singles.has(name)) throw new ArgumentError(`--${name} was given more than once.`)
    singles.set(name, value)
  }

  let optionsEnded = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!

    if (optionsEnded || !argument.startsWith('-') || argument === '-') {
      positional.push(argument)
      continue
    }
    if (argument === '--') {
      optionsEnded = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new ArgumentError(`Unknown option ${argument}. Options are spelled with two dashes.`)
    }

    const equals = argument.indexOf('=')
    if (equals !== -1) {
      const name = argument.slice(2, equals)
      const kind = kindOf(name)
      if (kind === 'switch') throw new ArgumentError(`--${name} takes no value.`)
      record(name, kind, argument.slice(equals + 1))
      continue
    }

    const name = argument.slice(2)
    const kind = kindOf(name)
    if (kind === 'switch') {
      // Repeated the same way a repeated value flag is: the documented rule is
      // that nothing but `values` may be given twice, and a caller who passes
      // `--json --json` believes something this parser cannot honour.
      if (switches.has(name)) throw new ArgumentError(`--${name} was given more than once.`)
      switches.add(name)
      continue
    }

    const next = argv[index + 1]
    if (next === undefined) throw new ArgumentError(`--${name} needs a value, and is the last argument.`)
    // A flag where a value belongs is the shape a truncated argument list takes,
    // and reading it as the value is how `--out --foo` wrote to a file called
    // `--foo`. `--name=--foo` remains available for a value that really does
    // begin with dashes.
    //
    // Any dash-led token, not only `--`: `-o` is refused as an unknown option
    // everywhere else here, so taking it as a *value* was the one place this
    // parser read a flag as data. A lone `-` is conventionally stdin, and is a
    // value.
    if (next.startsWith('-') && next !== '-') {
      throw new ArgumentError(`--${name} needs a value, but is followed by ${next}.`)
    }
    record(name, kind, next)
    index += 1
  }

  return {
    positional,
    switch: (name) => switches.has(name),
    value: (name) => singles.get(name) ?? null,
    values: (name) => repeated.get(name) ?? [],
  }
}

/**
 * Refuses a positional count the caller cannot work with.
 *
 * `what` names what those arguments are, so the message says which ones are
 * missing rather than only restating the usage line the caller will print
 * underneath it anyway.
 */
export function requirePositional(parsed: ParsedArgs, count: number, what: string): string[] {
  if (parsed.positional.length !== count) {
    throw new ArgumentError(
      `Expected ${count} argument${count === 1 ? '' : 's'} (${what}), and got ${parsed.positional.length}.`,
    )
  }
  return parsed.positional
}

/**
 * Refuses any positional argument at all.
 *
 * For the scripts that take only options. Without it a stray bare token — a
 * workflow expression that expanded to an extra word, an argument the shell
 * split — is collected into `positional`, never read, and silently ignored
 * while the script goes on to do its job. That is the same "a malformed
 * invocation reads as a valid one" this parser exists to end, and it was still
 * true of the two scripts that mutate a release.
 */
export function requireNoPositional(parsed: ParsedArgs): void {
  if (parsed.positional.length > 0) {
    throw new ArgumentError(
      `Unexpected argument ${JSON.stringify(parsed.positional[0])}; this command takes options only.`,
    )
  }
}
