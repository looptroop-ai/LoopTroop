/**
 * The block scalar header grammar, once.
 *
 * `|` or `>`, then the indicators YAML allows in either order — a chomping
 * `+`/`-` and an explicit indentation digit — then an optional comment.
 *
 * Sixteen copies of this lived in this file in four variants: some accepted a
 * trailing comment, some a `- ` list form, none an indentation indicator. A
 * repair whose copy did not match a header never entered its block-scalar
 * state and went on tokenizing the body as YAML, which is how
 * `description: |2` / `  key1: v1 key2: v2` came back as two lines — a newline
 * invented inside a value a model wrote. One grammar, so a header shape is
 * recognised by all of them or by none.
 *
 * Written out four times rather than composed from one source string: a
 * `new RegExp` built from a variable is a non-literal constructor, which is a
 * security-scanner finding in its own right. The four spell the same indicator
 * — `[>|](?:[+-][1-9]?|[1-9][+-]?)?` — and the same optional-comment tail, and
 * `yamlRepair.test.ts` holds them to that rather than the compiler.
 */
/** `key: |`, at the end of a mapping line. */
export const MAPPING_BLOCK_SCALAR_HEADER = /:\s*[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?\s*$/
/** `- |`, a block scalar as a sequence entry, which carries no key. */
export const LIST_BLOCK_SCALAR_HEADER = /^-\s*[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?\s*$/
/** Either form. Most repairs walk lines and need both. */
export const BLOCK_SCALAR_HEADER = /(?::|^-)\s*[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?\s*$/
/** The indicator alone, as a value: `foo:` on one line and `|` on the next. */
export const BLOCK_SCALAR_VALUE = /^\s*([>|](?:[+-][1-9]?|[1-9][+-]?)?)(?:\s+#.*)?\s*$/

/**
 * Repair YAML list items where the dash is not followed by a space.
 *
 * Models sometimes emit `-key: value` instead of `- key: value`.
 * YAML requires a space after the dash for a block sequence entry.
 * This function inserts the missing space.
 */
export function repairYamlListDashSpace(yaml: string): string {
  const result: string[] = []
  let blockScalarBaseIndent = -1

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // A literal block's body is text: `-key: value` inside one is what the
    // model wrote, not a sequence entry missing its space.
    if (blockScalarBaseIndent >= 0) {
      if (getLineIndent(line) > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }
    if (BLOCK_SCALAR_HEADER.test(trimmed)) {
      blockScalarBaseIndent = getLineIndent(line)
      result.push(line)
      continue
    }

    const match = line.match(/^(\s*)-([a-zA-Z_]\w*\s*:.*)$/)
    result.push(match ? `${match[1]}- ${match[2]}` : line)
  }

  return result.join('\n')
}

/**
 * Repair YAML indentation for list items produced by model output.
 *
 * Models sometimes emit properties within list items at the wrong indent
 * (e.g. 3-space instead of 2-space offset from the dash). This function
 * normalizes property lines so that they sit at dash_indent + 2.
 */
export function repairYamlIndentation(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER

  // Track the expected indent for properties inside the current list item.
  // Set when we see `- key:` and cleared when we leave that indent context.
  let expectedPropertyIndent = -1
  let dashIndent = -1
  let activeNestedIndent = -1
  let activeBlockScalarIndent = -1

  for (const line of lines) {
    // Blank lines or comment-only lines pass through unchanged
    if (!line.trim() || line.trimStart().startsWith('#')) {
      result.push(line)
      continue
    }

    // Detect list item start: `  - key: value` or `  - key:`
    const [, dashPrefix, dashRest] = line.match(/^(\s*)-\s+([a-z_]+\s*:.*)$/i) ?? []
    if (dashPrefix !== undefined && dashRest !== undefined) {
      dashIndent = dashPrefix.length
      expectedPropertyIndent = dashIndent + 2
      activeNestedIndent = -1
      activeBlockScalarIndent = BLOCK_SCALAR_PATTERN.test(dashRest.trimEnd()) ? dashIndent : -1
      result.push(line)
      continue
    }

    // If we're inside a list item, check bare property lines for indent mismatch
    if (expectedPropertyIndent >= 0) {
      const actualIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0

      if (activeBlockScalarIndent >= 0) {
        if (actualIndent > activeBlockScalarIndent) {
          result.push(line)
          continue
        }
        activeBlockScalarIndent = -1
      }

      if (activeNestedIndent >= 0) {
        if (actualIndent >= activeNestedIndent) {
          result.push(line)
          continue
        }
        if (actualIndent <= expectedPropertyIndent) {
          activeNestedIndent = -1
        }
      }

      const propMatch = line.match(/^(\s*)([a-z_]+\s*:.*)$/i)
      if (propMatch) {
        const isBlockScalar = BLOCK_SCALAR_PATTERN.test(propMatch[2]!.trimEnd())
        if (actualIndent === expectedPropertyIndent && propMatch[2]!.trimEnd().endsWith(':')) {
          activeNestedIndent = actualIndent + 2
          result.push(line)
          continue
        }

        // Only fix if the line is clearly a sibling property of the list item:
        // its indent is close to (but not equal to) the expected indent,
        // and it's deeper than the dash itself. Nested mappings/lists are
        // handled by `activeNestedIndent` above and preserved as-is.
        if (
          actualIndent !== expectedPropertyIndent
          && actualIndent > dashIndent
          && Math.abs(actualIndent - expectedPropertyIndent) <= 2
        ) {
          const repaired = ' '.repeat(expectedPropertyIndent) + propMatch[2]
          if (propMatch[2]!.trimEnd().endsWith(':')) {
            activeNestedIndent = expectedPropertyIndent + 2
          }
          if (isBlockScalar) {
            activeBlockScalarIndent = expectedPropertyIndent
          }
          result.push(repaired)
          continue
        }

        // If indent matches expected or is deeper (nested), pass through
        if (actualIndent >= expectedPropertyIndent) {
          if (isBlockScalar) {
            activeBlockScalarIndent = actualIndent
          }
          result.push(line)
          continue
        }

        // If indent is at or before the dash level, we've left this list item
        expectedPropertyIndent = -1
        dashIndent = -1
        activeNestedIndent = -1
        activeBlockScalarIndent = -1
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

function normalizeYamlRepairKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export interface YamlSequenceItemPrimaryKeyRepair {
  parentKey: string
  primaryKey: string
  value: string
  line: number
}

export interface YamlSequenceItemPrimaryKeyConfig {
  primaryKey: string
  childKeys: readonly string[]
}

export type YamlSequenceItemPrimaryKeyOptions = Record<string, YamlSequenceItemPrimaryKeyConfig>

export interface YamlSequenceItemPrimaryKeyRepairResult {
  yaml: string
  repairs: YamlSequenceItemPrimaryKeyRepair[]
}

interface YamlSequenceParentContext {
  key: string
  normalizedKey: string
  indent: number
}

interface NormalizedYamlSequenceItemPrimaryKeyConfig {
  primaryKey: string
  normalizedPrimaryKey: string
  childKeys: Set<string>
}

function normalizeSequenceItemPrimaryKeyOptions(
  options: YamlSequenceItemPrimaryKeyOptions | undefined,
): Map<string, NormalizedYamlSequenceItemPrimaryKeyConfig> {
  const normalized = new Map<string, NormalizedYamlSequenceItemPrimaryKeyConfig>()

  for (const [parentKey, config] of Object.entries(options ?? {})) {
    const normalizedParentKey = normalizeYamlRepairKey(parentKey)
    const primaryKey = config.primaryKey.trim()
    if (!normalizedParentKey || !primaryKey || config.childKeys.length === 0) continue

    normalized.set(normalizedParentKey, {
      primaryKey,
      normalizedPrimaryKey: normalizeYamlRepairKey(primaryKey),
      childKeys: new Set(config.childKeys.map(normalizeYamlRepairKey).filter(Boolean)),
    })
  }

  return normalized
}

function readSafeBareSequenceScalar(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes(':') || trimmed.startsWith('#')) return null
  if (/^[>|[\]{}&*!?@`]/.test(trimmed)) return null

  const quote = trimmed[0]
  if ((quote === '"' || quote === '\'') && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed
  }

  if (/\s/.test(trimmed)) return null
  return /^[A-Za-z0-9_./\\~@()[\]+=$,-]+$/.test(trimmed) ? trimmed : null
}

function findNextSignificantLine(lines: string[], startIndex: number): string | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return line
  }

  return null
}

function isKnownSequenceItemChildLine(
  line: string,
  dashIndent: number,
  config: NormalizedYamlSequenceItemPrimaryKeyConfig,
): boolean {
  const match = line.match(/^(\s*)([A-Za-z_][\w_-]*)\s*:/)
  if (!match) return false

  const childIndent = match[1]!.length
  if (childIndent <= dashIndent) return false

  const childKey = normalizeYamlRepairKey(match[2]!)
  return childKey !== config.normalizedPrimaryKey && config.childKeys.has(childKey)
}

function isSequenceItemMappingChildLine(line: string, dashIndent: number): boolean {
  const match = line.match(/^(\s*)([A-Za-z_][\w_-]*)\s*:/)
  if (!match) return false

  return match[1]!.length > dashIndent
}

// Hoisted out of the function body: these are tested once per line of every
// candidate. None carries the `g` flag, so there is no `lastIndex` to reset.
const SEQUENCE_PRIMARY_KEY_BARE_COLLECTION_KEY = /^(\s*)([A-Za-z_][\w_-]*)\s*:\s*(?:#.*)?$/
const SEQUENCE_PRIMARY_KEY_BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
const SEQUENCE_PRIMARY_KEY_DASH_SCALAR_LINE = /^(\s*)-\s+(.+)$/

/**
 * Repair structured YAML list entries that emit the primary key as a bare item.
 *
 * Some models emit:
 *
 *   beads:
 *     - config-schema-addition
 *       title: Add config schema
 *
 * That is invalid YAML because the child mapping is attached to a scalar list
 * item. This repair is opt-in per parent key and only moves the existing scalar
 * text into the configured primary key when the following line proves the item
 * is meant to be an object.
 */
export function repairYamlSequenceItemPrimaryKeys(
  yaml: string,
  options: YamlSequenceItemPrimaryKeyOptions | undefined,
): YamlSequenceItemPrimaryKeyRepairResult {
  const normalizedOptions = normalizeSequenceItemPrimaryKeyOptions(options)
  if (normalizedOptions.size === 0) return { yaml, repairs: [] }

  const lines = yaml.split('\n')
  const result: string[] = []
  const repairs: YamlSequenceItemPrimaryKeyRepair[] = []
  const parentStack: YamlSequenceParentContext[] = []
  let blockScalarBaseIndent = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const indent = getLineIndent(line)

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    while (parentStack.length > 0 && parentStack[parentStack.length - 1]!.indent >= indent) {
      parentStack.pop()
    }

    const dashMatch = line.match(SEQUENCE_PRIMARY_KEY_DASH_SCALAR_LINE)
    if (dashMatch) {
      const dashIndent = dashMatch[1]!.length
      const immediateParent = parentStack[parentStack.length - 1]
      const config = immediateParent ? normalizedOptions.get(immediateParent.normalizedKey) : undefined
      const value = config ? readSafeBareSequenceScalar(dashMatch[2]!) : null
      const nextLine = value ? findNextSignificantLine(lines, index + 1) : null

      if (
        immediateParent
        && config
        && dashIndent > immediateParent.indent
        && value
        && nextLine
        && isKnownSequenceItemChildLine(nextLine, dashIndent, config)
      ) {
        result.push(`${dashMatch[1]}- ${config.primaryKey}: ${value}`)
        repairs.push({
          parentKey: immediateParent.key,
          primaryKey: config.primaryKey,
          value,
          line: index + 1,
        })
        continue
      }

      result.push(line)
      continue
    }

    const parentMatch = line.match(SEQUENCE_PRIMARY_KEY_BARE_COLLECTION_KEY)
    if (parentMatch) {
      parentStack.push({
        key: parentMatch[2]!,
        normalizedKey: normalizeYamlRepairKey(parentMatch[2]!),
        indent: parentMatch[1]!.length,
      })
      result.push(line)
      continue
    }

    result.push(line)
    if (SEQUENCE_PRIMARY_KEY_BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
    }
  }

  return {
    yaml: result.join('\n'),
    repairs,
  }
}

const INLINE_SEQUENCE_SCALAR_PARENT_KEYS = new Set([
  'artifact',
  'content',
  'description',
  'id',
  'phase',
  'question',
  'rationale',
  'status',
  'summary',
  'text',
  'title',
])

const INLINE_SEQUENCE_PARENT_KEYS = new Set([
  'acceptancecriteria',
  'affecteditems',
  'antipatterns',
  'apicontracts',
  'architectureconstraints',
  'beads',
  'changes',
  'children',
  'commands',
  'constraints',
  'datamodel',
  'dependencies',
  'duplicatekeycollisions',
  'entries',
  'epics',
  'errorhandlingrules',
  'errors',
  'files',
  'followupquestions',
  'followuprounds',
  'gapresolutions',
  'gaps',
  'goals',
  'implementationsteps',
  'inscope',
  'interviewquestions',
  'invalidentries',
  'items',
  'labels',
  'nongoals',
  'options',
  'outofscope',
  'overwrittenkeys',
  'patterns',
  'performanceconstraints',
  'prdrefs',
  'questions',
  'records',
  'rejectedentries',
  'reliabilityconstraints',
  'requiredcommands',
  'results',
  'risks',
  'securityconstraints',
  'selectedoptionids',
  'stories',
  'targetfiles',
  'targetusers',
  'testcommands',
  'tests',
  'toolingassumptions',
  'userstories',
  'validentries',
  'warnings',
])

function isLikelyInlineSequenceParentKey(key: string): boolean {
  const normalized = normalizeYamlRepairKey(key)
  if (!normalized || INLINE_SEQUENCE_SCALAR_PARENT_KEYS.has(normalized)) return false
  return INLINE_SEQUENCE_PARENT_KEYS.has(normalized)
    || normalized.endsWith('list')
    || normalized.endsWith('items')
}

/**
 * Repair inline block-sequence parents.
 *
 * Models sometimes emit `questions: - id: Q01 ...` instead of opening the
 * sequence on the next line. YAML accepts that as a plain scalar, so this
 * repair must run before the first YAML parse. It only targets collection-like
 * parent keys and preserves the entire emitted sequence entry text.
 */
export function repairYamlInlineSequenceParents(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // `items: - item` inside a literal block is a sentence, not a mapping whose
    // sequence needs unfolding onto two lines.
    if (blockScalarBaseIndent >= 0) {
      if (getLineIndent(line) > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }
    if (BLOCK_SCALAR_HEADER.test(trimmed)) {
      blockScalarBaseIndent = getLineIndent(line)
      result.push(line)
      continue
    }

    const match = line.match(/^(\s*)([A-Za-z_][\w_-]*)\s*:\s+-\s+(.+)$/)
    if (!match || !isLikelyInlineSequenceParentKey(match[2]!)) {
      result.push(line)
      continue
    }

    result.push(`${match[1]}${match[2]}:`)
    result.push(`${match[1]}  - ${match[3]}`)
  }

  return result.join('\n')
}

export interface YamlMappingKeyColonSpaceOptions {
  sequenceItemPrimaryKeys?: YamlSequenceItemPrimaryKeyOptions
}

/**
 * Repair mapping keys where the colon is missing the required following space.
 *
 * Models sometimes emit `artifact:interview` or `- id:Q01`. YAML treats those
 * as plain scalars rather than mapping entries, so this repair runs before the
 * first YAML parse. A dash-prefixed line is repaired only when its surrounding
 * structure proves it is a mapping item: it has an indented mapping child, or
 * it uses the configured primary key for a known structured sequence. This
 * preserves valid scalar list values such as `- style:main` and `- package:version`.
 */
export function repairYamlMappingKeyColonSpace(
  yaml: string,
  options?: YamlMappingKeyColonSpaceOptions,
): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  const BARE_COLLECTION_KEY = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(?:#.*)?$/
  const normalizedSequenceOptions = normalizeSequenceItemPrimaryKeyOptions(options?.sequenceItemPrimaryKeys)
  const parentStack: YamlSequenceParentContext[] = []
  let blockScalarBaseIndent = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const indent = getLineIndent(line)

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // A base indent of -1 means "not inside a block scalar"; every entry sets a
    // real indent and every exit resets it to -1.

    if (blockScalarBaseIndent >= 0) {
      if (!trimmed || indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    while (parentStack.length > 0 && parentStack[parentStack.length - 1]!.indent >= indent) {
      parentStack.pop()
    }

    const match = line.match(/^(\s*(?:-\s+)?)([A-Za-z_][\w-]*):(?![\s]|$)(.*)$/)
    if (match && match[2]!.length >= 2 && !match[3]?.startsWith('//')) {
      const listPrefix = match[1]!.match(/^(\s*)-\s+$/)
      let shouldRepair = !listPrefix

      if (listPrefix) {
        const dashIndent = listPrefix[1]!.length
        const immediateParent = parentStack[parentStack.length - 1]
        const config = immediateParent
          ? normalizedSequenceOptions.get(immediateParent.normalizedKey)
          : undefined
        const nextLine = findNextSignificantLine(lines, index + 1)
        const hasIndentedMappingChild = nextLine
          ? isSequenceItemMappingChildLine(nextLine, dashIndent)
          : false
        const isConfiguredPrimaryKey = Boolean(
          immediateParent
          && config
          && dashIndent > immediateParent.indent
          && normalizeYamlRepairKey(match[2]!) === config.normalizedPrimaryKey,
        )

        shouldRepair = hasIndentedMappingChild || isConfiguredPrimaryKey
      }

      if (shouldRepair) {
        const repaired = `${match[1]}${match[2]}: ${match[3]}`
        result.push(repaired)
        if (BLOCK_SCALAR_PATTERN.test(repaired.trimEnd())) {
          blockScalarBaseIndent = indent
        }
        continue
      }
    }

    result.push(line)
    const parentMatch = line.match(BARE_COLLECTION_KEY)
    if (parentMatch) {
      parentStack.push({
        key: parentMatch[2]!,
        normalizedKey: normalizeYamlRepairKey(parentMatch[2]!),
        indent: parentMatch[1]!.length,
      })
    }
    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
    }
  }

  return result.join('\n')
}

function getLineIndent(line: string): number {
  return line.match(/^(\s*)/)?.[1]?.length ?? 0
}

function replaceLineIndent(line: string, indent: number): string {
  return `${' '.repeat(indent)}${line.trimStart()}`
}

function replaceLineWithBareMappingKey(line: string, key: string): string {
  return `${' '.repeat(getLineIndent(line))}${key}:`
}

function hasOddTrailingBackslashes(value: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function findLastUnescapedDoubleQuote(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === '"' && !hasOddTrailingBackslashes(value, index)) {
      return index
    }
  }
  return -1
}

function isHexDigit(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-fA-F]$/.test(value))
}

function hasHexDigits(value: string, start: number, count: number): boolean {
  for (let offset = 0; offset < count; offset += 1) {
    if (!isHexDigit(value[start + offset])) {
      return false
    }
  }
  return true
}

function isValidYamlDoubleQuotedEscape(value: string, slashIndex: number): boolean {
  const next = value[slashIndex + 1]
  if (next === undefined) return true

  if ('0abt\tnvfre "/\\N_LP'.includes(next)) {
    return true
  }

  if (next === 'x') {
    return hasHexDigits(value, slashIndex + 2, 2)
  }

  if (next === 'u') {
    return hasHexDigits(value, slashIndex + 2, 4)
  }

  if (next === 'U') {
    return hasHexDigits(value, slashIndex + 2, 8)
  }

  return false
}

/**
 * Escape invalid backslash sequences inside YAML double-quoted scalars.
 *
 * YAML double-quoted strings treat backslash as an escape introducer, so
 * regex-like text such as `"\+"` is invalid even though the model meant a
 * literal backslash. This repair only doubles backslashes that start invalid
 * YAML escapes while preserving valid YAML escapes, single-quoted strings,
 * comments, and block scalar bodies.
 */
export function repairYamlDoubleQuotedInvalidEscapes(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const MAPPING_BLOCK_SCALAR_PATTERN = MAPPING_BLOCK_SCALAR_HEADER
  const LIST_BLOCK_SCALAR_PATTERN = LIST_BLOCK_SCALAR_HEADER

  let insideSingleQuote = false
  let insideDoubleQuote = false
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()
    const indent = getLineIndent(line)

    if (blockScalarBaseIndent >= 0) {
      if (!trimmed || indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    let repairedLine = ''
    let reachedComment = false

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!

      if (char === '#' && !insideSingleQuote && !insideDoubleQuote) {
        if (index === 0 || /\s/.test(line[index - 1] ?? '')) {
          repairedLine += line.slice(index)
          reachedComment = true
          break
        }
      }

      if (char === '\'' && !insideDoubleQuote) {
        repairedLine += char
        if (insideSingleQuote && line[index + 1] === '\'') {
          index += 1
          repairedLine += line[index]!
          continue
        }
        insideSingleQuote = !insideSingleQuote
        continue
      }

      if (char === '"' && !insideSingleQuote && !hasOddTrailingBackslashes(line, index)) {
        insideDoubleQuote = !insideDoubleQuote
        repairedLine += char
        continue
      }

      if (char === '\\' && insideDoubleQuote && !isValidYamlDoubleQuotedEscape(line, index)) {
        repairedLine += '\\\\'
        continue
      }

      repairedLine += char
    }

    result.push(repairedLine)

    if (!reachedComment && !insideSingleQuote && !insideDoubleQuote) {
      const repairedTrimmed = repairedLine.trim()
      if (MAPPING_BLOCK_SCALAR_PATTERN.test(repairedTrimmed) || LIST_BLOCK_SCALAR_PATTERN.test(repairedTrimmed)) {
        blockScalarBaseIndent = indent
      }
    }
  }

  return result.join('\n')
}

/**
 * Escape unescaped inner quotes inside one-line double-quoted scalars.
 *
 * Models often emit prose like:
 *
 *   free_text: "Errors include `origin: "date"`, `minimum`, and `maximum`."
 *
 * The visible text is clear, but YAML treats the quote before `date` as the
 * end of the scalar. This repair keeps the first and last unescaped quotes as
 * delimiters and escapes existing unescaped quotes between them. It never
 * creates new text and skips block scalar bodies.
 */
export function repairYamlDoubleQuotedScalarInnerQuotes(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  let blockScalarBaseIndent = -1

  const repairValue = (value: string): string | null => {
    if (!value.startsWith('"')) return null

    const closingQuoteIndex = findLastUnescapedDoubleQuote(value)
    if (closingQuoteIndex <= 0) return null

    const afterClosing = value.slice(closingQuoteIndex + 1)
    if (!/^\s*(?:#.*)?$/.test(afterClosing)) return null

    const body = value.slice(1, closingQuoteIndex)
    let repairedBody = ''
    let changed = false

    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!
      if (char === '"' && !hasOddTrailingBackslashes(body, index)) {
        repairedBody += '\\"'
        changed = true
        continue
      }
      repairedBody += char
    }

    return changed ? `"${repairedBody}"${afterClosing}` : null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const indent = getLineIndent(line)
    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    const mappingMatch = line.match(/^(\s*(?:-\s+)?[A-Za-z_][\w_-]*\s*:\s*)(.+)$/)
    if (mappingMatch) {
      if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
        blockScalarBaseIndent = indent
        result.push(line)
        continue
      }

      const repaired = repairValue(mappingMatch[2]!)
      if (repaired !== null) {
        result.push(`${mappingMatch[1]}${repaired}`)
        continue
      }
    }

    const listScalarMatch = line.match(/^(\s*-\s+)(.+)$/)
    if (listScalarMatch && !/^[A-Za-z_][\w_-]*\s*:/.test(listScalarMatch[2]!)) {
      const repaired = repairValue(listScalarMatch[2]!)
      if (repaired !== null) {
        result.push(`${listScalarMatch[1]}${repaired}`)
        continue
      }
    }

    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
    }

    result.push(line)
  }

  return result.join('\n')
}

function hasFollowingWhitelistedSiblingChild(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  allowedChildren: ReadonlySet<string>,
): boolean {
  for (let cursor = startIndex; cursor < lines.length; cursor += 1) {
    const currentLine = lines[cursor]!
    const currentTrimmed = currentLine.trim()

    if (!currentTrimmed || currentTrimmed.startsWith('#')) {
      continue
    }

    const currentIndent = getLineIndent(currentLine)
    if (currentIndent > parentIndent) {
      continue
    }

    const currentMatch = currentTrimmed.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/)
    if (!currentMatch) {
      return false
    }

    return allowedChildren.has(normalizeYamlRepairKey(currentMatch[1]!))
  }

  return false
}

/**
 * Repair known nested mapping children that were emitted at the parent indent.
 *
 * Models sometimes emit a bare parent key such as `generated_by:` and then
 * place known child keys like `winner_model:` or `generated_at:` at the same
 * indentation level. This helper only repairs explicitly whitelisted parent /
 * child relationships and stops before the first unknown sibling mapping.
 */
export function repairYamlNestedMappingChildren(
  yaml: string,
  nestedMappingChildren: Record<string, readonly string[]>,
): string {
  const normalizedConfig = new Map<string, Set<string>>()
  for (const [parentKey, childKeys] of Object.entries(nestedMappingChildren)) {
    const normalizedParent = normalizeYamlRepairKey(parentKey)
    if (!normalizedParent) continue
    const normalizedChildren = new Set(
      childKeys
        .map((childKey) => normalizeYamlRepairKey(childKey))
        .filter(Boolean),
    )
    if (normalizedChildren.size > 0) {
      normalizedConfig.set(normalizedParent, normalizedChildren)
    }
  }

  if (normalizedConfig.size === 0) {
    return yaml
  }

  const lines = yaml.split('\n')
  const result: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()

    const bareParentMatch = trimmed.match(/^([A-Za-z_][\w-]*)\s*:\s*$/)
    const inlinePlaceholderParentMatch = trimmed.match(/^([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)\s*$/)
    const bareParentKey = bareParentMatch?.[1]
    const inlineParentKey = inlinePlaceholderParentMatch?.[1]
    const inlinePlaceholderChild = inlinePlaceholderParentMatch?.[2]
    const allowedChildren = bareParentKey
      ? normalizedConfig.get(normalizeYamlRepairKey(bareParentKey))
      : inlineParentKey
        ? normalizedConfig.get(normalizeYamlRepairKey(inlineParentKey))
        : undefined

    if (!allowedChildren) {
      result.push(line)
      continue
    }

    const parentIndent = getLineIndent(line)
    const shouldRepairInlinePlaceholder = Boolean(
      inlineParentKey
      && inlinePlaceholderChild
      && allowedChildren.has(normalizeYamlRepairKey(inlinePlaceholderChild))
      && hasFollowingWhitelistedSiblingChild(lines, index + 1, parentIndent, allowedChildren),
    )

    if (!bareParentKey && !shouldRepairInlinePlaceholder) {
      result.push(line)
      continue
    }

    result.push(
      shouldRepairInlinePlaceholder
        ? replaceLineWithBareMappingKey(line, inlineParentKey!)
        : line,
    )

    let cursor = index + 1
    while (cursor < lines.length) {
      const currentLine = lines[cursor]!
      const currentTrimmed = currentLine.trim()

      if (!currentTrimmed || currentTrimmed.startsWith('#')) {
        result.push(currentLine)
        cursor += 1
        continue
      }

      const currentIndent = getLineIndent(currentLine)
      if (currentIndent > parentIndent) {
        result.push(currentLine)
        cursor += 1
        continue
      }

      const currentMatch = currentTrimmed.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/)
      if (!currentMatch) {
        break
      }

      if (!allowedChildren.has(normalizeYamlRepairKey(currentMatch[1]!))) {
        break
      }

      const childSourceIndent = currentIndent
      const childTargetIndent = parentIndent + 2
      const childOpensNested = currentMatch[2]!.trim().length === 0
        || /^[>|][+-]?(?:\s+#.*)?$/.test(currentMatch[2]!.trim())
      const childDelta = childTargetIndent - childSourceIndent

      const repairedChildLine = replaceLineIndent(currentLine, childTargetIndent)
      result.push(repairedChildLine)
      cursor += 1

      while (cursor < lines.length) {
        const nestedLine = lines[cursor]!
        const nestedTrimmed = nestedLine.trim()

        if (!nestedTrimmed || nestedTrimmed.startsWith('#')) {
          result.push(nestedLine)
          cursor += 1
          continue
        }

        if (nestedTrimmed === '---' || nestedTrimmed === '...') {
          break
        }

        const nestedIndent = getLineIndent(nestedLine)
        const nestedMatch = nestedTrimmed.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/)
        if (nestedMatch && nestedIndent <= childTargetIndent) {
          if (allowedChildren.has(normalizeYamlRepairKey(nestedMatch[1]!))) {
            break
          }
          if (nestedIndent <= parentIndent) {
            break
          }
        }

        if (!childOpensNested) {
          break
        }

        const repairedIndent = nestedIndent > childSourceIndent
          ? nestedIndent + childDelta
          : childTargetIndent + 2
        result.push(replaceLineIndent(nestedLine, repairedIndent))
        cursor += 1
      }
    }

    index = cursor - 1
  }

  return result.join('\n')
}

/**
 * Repair inconsistent sequence entry indentation.
 *
 * Models sometimes emit the first `- ` in a sequence at one indent level,
 * then drift subsequent entries by 1-3 spaces (typically after a block
 * scalar like `>-`). This function normalizes all sibling dashes to match
 * the indent of the first entry in each sequence.
 */
export function repairYamlSequenceEntryIndent(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  const DASH_LINE = /^(\s*)-(\s+.*)$/
  const BARE_KEY = /^[a-z_][\w_-]*\s*:\s*$/i
  const MAX_SIBLING_DELTA = 3

  // Sorted array of anchor indents for known sequence levels.
  const anchors: number[] = []
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const actualIndent = (line.match(/^(\s*)/) ?? [''])[0].length

    // Block scalar continuation — skip
    if (blockScalarBaseIndent >= 0) {
      if (actualIndent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    // Bare mapping key (e.g. "questions:") — reset deeper anchors
    // No DASH_LINE guard: BARE_KEY is tested against the trimmed line, and a
    // sequence entry trims to a leading '-', which BARE_KEY cannot match.
    if (BARE_KEY.test(trimmed)) {
      while (anchors.length > 0 && anchors[anchors.length - 1]! > actualIndent) {
        anchors.pop()
      }
      result.push(line)
      continue
    }

    const dashMatch = line.match(DASH_LINE)
    if (dashMatch) {
      const dashIndent = dashMatch[1]!.length
      const rest = dashMatch[2]!

      // Find closest anchor within MAX_SIBLING_DELTA
      let bestAnchor: number | null = null
      let bestDelta = MAX_SIBLING_DELTA + 1
      for (const anchor of anchors) {
        const delta = Math.abs(dashIndent - anchor)
        if (delta <= MAX_SIBLING_DELTA && delta < bestDelta) {
          bestAnchor = anchor
          bestDelta = delta
        }
      }

      if (bestAnchor !== null) {
        // Sibling — normalize to anchor and pop any deeper anchors
        while (anchors.length > 0 && anchors[anchors.length - 1]! > bestAnchor) {
          anchors.pop()
        }
        if (dashIndent !== bestAnchor) {
          result.push(' '.repeat(bestAnchor) + '-' + rest)
        } else {
          result.push(line)
        }
      } else {
        // New sequence level
        anchors.push(dashIndent)
        result.push(line)
      }

      // Track block scalar on dash line, tested against the whole line rather
      // than the text after the dash: for a bare `- |` the indicator *is* that
      // text, so a header test expecting a key before it never matched and the
      // body was re-indented as sibling sequence entries — a value change.
      if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
        blockScalarBaseIndent = bestAnchor ?? dashIndent
      }
      continue
    }

    // Non-dash line — track block scalars
    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = actualIndent
    }

    result.push(line)
  }

  return result.join('\n')
}

// Hoisted; tested once per line, using the shared block-scalar grammar.
const DUPLICATE_KEYS_BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER

/**
 * Remove exact-duplicate mapping keys from YAML.
 *
 * Models sometimes emit the same key-value pair twice within a mapping, or
 * repeat a block key like `options:` with the same nested list. This function
 * removes exact duplicates (same key + same full line text) while preserving
 * entries with different values (those are ambiguous and should be left for
 * js-yaml to error on). When the duplicate key opens a nested block, the
 * duplicate block contents are removed as well so they do not get merged into
 * the first key during YAML parsing.
 */
export function repairYamlDuplicateKeys(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []

  // Map from effective indent level → Map<key_name, full_line_text>
  const seenByIndent = new Map<number, Map<string, string>>()

  // When >= 0, we are skipping nested lines of a removed duplicate mapping
  // block (for example a duplicate `options:` plus its list items).
  let skipNestedBlockIndent = -1

  // When >= 0, we are skipping continuation lines of a removed block-scalar duplicate
  let skipBlockScalarIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0

    if (skipNestedBlockIndent >= 0) {
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }
      if (lineIndent > skipNestedBlockIndent) {
        continue
      }
      skipNestedBlockIndent = -1
    }

    // If we're skipping block-scalar continuation of a removed duplicate
    if (skipBlockScalarIndent >= 0) {
      if (!trimmed || trimmed.startsWith('#') || lineIndent > skipBlockScalarIndent) {
        continue // skip continuation line
      }
      skipBlockScalarIndent = -1
    }

    // Blank / comment lines pass through
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // When indentation decreases, deeper mapping contexts are closed
    for (const level of [...seenByIndent.keys()]) {
      if (level > lineIndent) {
        seenByIndent.delete(level)
      }
    }

    // List item with key: `  - key: value`
    // Each list item starts a fresh mapping at effectiveIndent = dashIndent + 2
    const listItemKeyMatch = line.match(/^(\s*)-\s+([A-Za-z_][\w_-]*)\s*:(.*)$/)
    if (listItemKeyMatch) {
      const dashIndent = listItemKeyMatch[1]!.length
      const effectiveIndent = dashIndent + 2
      const key = listItemKeyMatch[2]!

      // New list item → fresh mapping context. This level needs no delete: the
      // `set` below replaces it outright.
      for (const level of [...seenByIndent.keys()]) {
        if (level > effectiveIndent) {
          seenByIndent.delete(level)
        }
      }

      const map = new Map<string, string>()
      map.set(key, line)
      seenByIndent.set(effectiveIndent, map)

      result.push(line)
      continue
    }

    // Bare mapping key: `key: value` or `  key: value`
    const keyMatch = line.match(/^(\s*)([A-Za-z_][\w_-]*)\s*:(.*)$/)
    if (keyMatch) {
      const key = keyMatch[2]!

      if (!seenByIndent.has(lineIndent)) {
        seenByIndent.set(lineIndent, new Map())
      }
      const seenAtLevel = seenByIndent.get(lineIndent)!

      const previousLine = seenAtLevel.get(key)
      if (previousLine === line) {
        // Exact duplicate — skip this line
        if (DUPLICATE_KEYS_BLOCK_SCALAR_PATTERN.test(trimmed)) {
          skipBlockScalarIndent = lineIndent
        } else {
          const valuePortion = keyMatch[3]?.trim() ?? ''
          if (!valuePortion || valuePortion.startsWith('#')) {
            skipNestedBlockIndent = lineIndent
          }
        }
        continue
      }

      seenAtLevel.set(key, line)
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Repair fragile `free_text` scalar values.
 *
 * `free_text` fields are always string-typed in our structured artifacts, but
 * models often emit them as plain YAML scalars. Those are fragile: values that
 * start with backticks, look like booleans, or contain `: ` can all break YAML
 * parsing or coerce to the wrong type. This repair wraps non-empty one-line
 * plain values in double quotes, converts malformed multi-line values into
 * block scalars, and preserves valid block scalars and already-quoted values.
 */
export function repairYamlFreeTextScalars(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  const BLOCK_SCALAR_VALUE_PATTERN = BLOCK_SCALAR_VALUE
  // Valid block scalar headers are handled before this plain-value guard.
  const SAFE_VALUE_START = /^["'&*!#]/
  let blockScalarBaseIndent = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    const freeTextMatch = line.match(/^(\s*(?:-\s+)?free_text\s*:\s*)(.+)$/)
    if (!freeTextMatch && BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
      result.push(line)
      continue
    }

    if (!freeTextMatch) {
      result.push(line)
      continue
    }

    const prefix = freeTextMatch[1]!
    const value = freeTextMatch[2]!
    const blockScalarValueMatch = value.match(BLOCK_SCALAR_VALUE_PATTERN)
    if (blockScalarValueMatch?.[1]) {
      const malformedBlockScalar = collectMalformedFreeTextBlockScalar(lines, index, indent)
      if (malformedBlockScalar) {
        result.push(`${prefix}${blockScalarValueMatch[1]}`)
        result.push(...malformedBlockScalar.lines)
        index = malformedBlockScalar.endIndex
        continue
      }

      result.push(line)
      blockScalarBaseIndent = indent
      continue
    }

    const multilineSingleQuoted = collectMultilineSingleQuotedFreeText(lines, index, indent)
    if (multilineSingleQuoted) {
      result.push(`${prefix}|-`)
      const contentIndent = ' '.repeat(indent + 2)
      for (const contentLine of multilineSingleQuoted.contentLines) {
        result.push(`${contentIndent}${contentLine}`)
      }
      index = multilineSingleQuoted.endIndex
      continue
    }

    const multilinePlainScalar = collectPlainMultilineFreeText(lines, index, indent, value)
    if (multilinePlainScalar) {
      result.push(`${prefix}|-`)
      result.push(...multilinePlainScalar.lines)
      index = multilinePlainScalar.endIndex
      continue
    }

    if (SAFE_VALUE_START.test(value)) {
      result.push(line)
      continue
    }

    // Quoting the whole captured value made `free_text: answer # note` store the
    // comment as part of the answer, and made this path disagree with every
    // document that parses without repair, where js-yaml drops the comment.
    const { value: scalarValue, comment } = splitYamlValueAndComment(value)
    result.push(`${prefix}${JSON.stringify(scalarValue)}${comment ? ` ${comment}` : ''}`)
  }

  return result.join('\n')
}

const FREE_TEXT_ANSWER_SIBLING_KEYS = new Set([
  'answered_at',
  'answered_by',
  'selected_option_ids',
  'skipped',
])

function isFreeTextAnswerSibling(trimmed: string): boolean {
  const match = trimmed.match(/^([A-Za-z_][\w-]*)\s*:/)
  return Boolean(match?.[1] && FREE_TEXT_ANSWER_SIBLING_KEYS.has(match[1].toLowerCase()))
}

function isYamlStructuralBoundary(trimmed: string): boolean {
  const normalized = trimmed.toLowerCase()
  return /^-\s+[a-z_][\w-]*\s*:/.test(normalized)
    || /^(approval|follow_up_rounds|questions|summary)\s*:/.test(normalized)
}

function collectMalformedFreeTextBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { endIndex: number; lines: string[] } | null {
  const nextNonEmptyIndex = findNextNonEmptyLineIndex(lines, startIndex + 1)
  if (nextNonEmptyIndex === null) return null

  const nextLine = lines[nextNonEmptyIndex]!
  // `nextTrimmed` is non-empty by construction: findNextNonEmptyLineIndex only
  // returns lines whose trim has length.
  const nextTrimmed = nextLine.trim()
  if (isFreeTextAnswerSibling(nextTrimmed)) return null

  const nextIndent = getLineIndent(nextLine)
  if (nextIndent > parentIndent) return null

  const result: string[] = []
  let endIndex = startIndex
  let hasContentLine = false
  const contentIndent = ' '.repeat(parentIndent + 2)
  const siblingIndent = ' '.repeat(parentIndent)

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const lineIndent = getLineIndent(line)

    if (!trimmed) {
      result.push('')
      endIndex = index
      continue
    }

    if (isFreeTextAnswerSibling(trimmed)) {
      result.push(`${siblingIndent}${trimmed}`)
      endIndex = index
      continue
    }

    if (lineIndent <= parentIndent && isYamlStructuralBoundary(trimmed)) {
      break
    }

    result.push(`${contentIndent}${line.trimStart()}`)
    hasContentLine = true
    endIndex = index
  }

  return hasContentLine ? { endIndex, lines: result } : null
}

function collectPlainMultilineFreeText(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  firstValue: string,
): { endIndex: number; lines: string[] } | null {
  const nextNonEmptyIndex = findNextNonEmptyLineIndex(lines, startIndex + 1)
  if (nextNonEmptyIndex === null) return null

  const nextLine = lines[nextNonEmptyIndex]!
  // Non-empty by construction; see findNextNonEmptyLineIndex.
  const nextTrimmed = nextLine.trim()
  const nextIndent = getLineIndent(nextLine)
  if (nextIndent <= parentIndent || isFreeTextAnswerSibling(nextTrimmed)) {
    return null
  }

  const continuationLines: string[] = []
  let endIndex = startIndex
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const lineIndent = getLineIndent(line)

    if (!trimmed) {
      continuationLines.push('')
      endIndex = index
      continue
    }

    if (lineIndent <= parentIndent || isFreeTextAnswerSibling(trimmed) || isYamlStructuralBoundary(trimmed)) {
      break
    }

    continuationLines.push(line.trimStart())
    endIndex = index
  }

  // `endIndex === startIndex` is not checked separately: every push into
  // `continuationLines` advances `endIndex` in the same iteration.
  if (continuationLines.length === 0) return null

  const contentIndent = ' '.repeat(parentIndent + 2)
  return {
    endIndex,
    lines: [
      `${contentIndent}${firstValue}`,
      ...continuationLines.map(line => (line ? `${contentIndent}${line}` : '')),
    ],
  }
}

const YAML_UNION_TOKEN_PATTERN = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[A-Za-z_][\\w.\\[\\]-]*)`
const YAML_UNION_SCALAR_PATTERN = new RegExp(
  `^(?:${YAML_UNION_TOKEN_PATTERN})(?:\\s*\\|\\s*(?:${YAML_UNION_TOKEN_PATTERN}))+\\s*$`,
)

function splitYamlValueAndComment(value: string): { value: string; comment: string } {
  let insideSingleQuote = false
  let insideDoubleQuote = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!

    if (char === '"' && !insideSingleQuote) {
      let backslashes = 0
      for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
        backslashes += 1
      }
      if (backslashes % 2 === 0) {
        insideDoubleQuote = !insideDoubleQuote
      }
      continue
    }

    if (char === '\'' && !insideDoubleQuote) {
      if (insideSingleQuote && value[index + 1] === '\'') {
        index += 1
        continue
      }
      insideSingleQuote = !insideSingleQuote
      continue
    }

    if (char === '#' && !insideSingleQuote && !insideDoubleQuote) {
      if (index === 0 || /\s/.test(value[index - 1] ?? '')) {
        return {
          value: value.slice(0, index).trimEnd(),
          comment: value.slice(index),
        }
      }
    }
  }

  return { value: value.trimEnd(), comment: '' }
}

function findLeadingQuotedScalarFragmentEnd(value: string): number | null {
  const openingQuote = value[0]
  if (openingQuote !== '\'' && openingQuote !== '"') return null

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]!

    if (openingQuote === '\'') {
      if (char !== '\'') continue
      if (value[index + 1] === '\'') {
        index += 1
        continue
      }
      return index
    }

    if (char !== '"') continue

    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 0) {
      return index
    }
  }

  return null
}

function repairLeadingQuotedScalarFragment(value: string): string | null {
  if (!value.startsWith('"') && !value.startsWith('\'')) return null

  const doubledSingleQuoteWrapperRepaired = repairDoubledSingleQuoteWrapper(value)
  if (doubledSingleQuoteWrapperRepaired !== null) {
    return doubledSingleQuoteWrapperRepaired
  }

  const { value: scalarValue, comment } = splitYamlValueAndComment(value)
  const fragmentEnd = findLeadingQuotedScalarFragmentEnd(scalarValue)
  if (fragmentEnd === null) return null

  const trailingText = scalarValue.slice(fragmentEnd + 1)
  if (!/^\s+\S/.test(trailingText)) return null

  return `${JSON.stringify(scalarValue)}${comment ? ` ${comment}` : ''}`
}

function repairDoubledSingleQuoteWrapper(value: string): string | null {
  if (!value.startsWith("''")) return null

  const { value: scalarValue, comment } = splitYamlValueAndComment(value)
  const trimmed = scalarValue.trim()
  if (!trimmed.startsWith("''") || trimmed.startsWith("'''") || trimmed === "''") {
    return null
  }

  let content = trimmed.slice(2)
  const hasClosingWrapper = content.endsWith("''") && content.length > 2
  if (hasClosingWrapper) {
    content = content.slice(0, -2)
  } else if (!/:\s/.test(content)) {
    return null
  }

  const normalizedContent = content.trim()
  if (!normalizedContent) return null

  return `${JSON.stringify(normalizedContent)}${comment ? ` ${comment}` : ''}`
}

function findNextNonEmptyLineIndex(lines: string[], startIndex: number): number | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim().length > 0) {
      return index
    }
  }

  return null
}

function repairQuotedBlockScalarIndicatorMapping(
  lines: string[],
  lineIndex: number,
  currentIndent: number,
  value: string,
): string | null {
  const { value: scalarValue, comment } = splitYamlValueAndComment(value)
  const indicatorMatch = scalarValue.trim().match(/^(['"])([>|](?:-)?)\1$/)
  if (!indicatorMatch?.[2]) return null

  const nextNonEmptyLineIndex = findNextNonEmptyLineIndex(lines, lineIndex + 1)
  if (nextNonEmptyLineIndex === null) return null

  const nextIndent = getLineIndent(lines[nextNonEmptyLineIndex]!)
  if (nextIndent <= currentIndent) return null

  return `${indicatorMatch[2]}${comment ? ` ${comment}` : ''}`
}

/**
 * Repair YAML scalars that start with a closed quoted fragment and then
 * continue as plain text on the same line.
 *
 * Models sometimes emit values like `- 'pink' is accepted...` or
 * `description: "pink" remains supported...`. YAML rejects these because a
 * quoted scalar cannot resume as plain text after the closing quote. This
 * repair wraps the full visible scalar in double quotes while preserving any
 * trailing comment. It also safely unquotes block-scalar indicators like
 * `description: "|-"` when the following indented lines clearly form the
 * block-scalar body.
 */
export function repairYamlQuotedScalarFragments(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  let blockScalarBaseIndent = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    const mappingMatch = line.match(/^(\s*(?:-\s+)?[A-Za-z_][\w_-]*\s*:\s+)(.+)$/)
    if (mappingMatch) {
      const prefix = mappingMatch[1]!
      const repairedBlockScalarIndicator = repairQuotedBlockScalarIndicatorMapping(lines, index, indent, mappingMatch[2]!)
      if (repairedBlockScalarIndicator !== null) {
        result.push(`${prefix}${repairedBlockScalarIndicator}`)
        blockScalarBaseIndent = indent
        continue
      }

      const repairedValue = repairLeadingQuotedScalarFragment(mappingMatch[2]!)
      if (repairedValue !== null) {
        result.push(`${prefix}${repairedValue}`)
        continue
      }
    }

    const listScalarMatch = line.match(/^(\s*-\s+)(.+)$/)
    if (listScalarMatch && !/^[A-Za-z_][\w_-]*\s*:/.test(listScalarMatch[2]!)) {
      const prefix = listScalarMatch[1]!
      const repairedValue = repairLeadingQuotedScalarFragment(listScalarMatch[2]!)
      if (repairedValue !== null) {
        result.push(`${prefix}${repairedValue}`)
        continue
      }
    }

    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Quote pseudo-type union scalars so YAML treats them as plain strings.
 *
 * Models sometimes emit schema-like values such as
 * `type: "epic" | "user_story"` or `- "unit" | "integration"`.
 * YAML interprets the `|` after a quoted token as block-scalar syntax and
 * rejects the document. This repair wraps the full scalar in quotes while
 * preserving any trailing comment.
 */
export function repairYamlTypeUnionScalars(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    const mappingMatch = line.match(/^(\s*(?:-\s+)?[A-Za-z_][\w_-]*\s*:\s+)(.+)$/)
    if (mappingMatch) {
      const prefix = mappingMatch[1]!
      const { value, comment } = splitYamlValueAndComment(mappingMatch[2]!)
      if (YAML_UNION_SCALAR_PATTERN.test(value.trim())) {
        result.push(`${prefix}${JSON.stringify(value.trim())}${comment ? ` ${comment}` : ''}`)
        continue
      }
    }

    const listScalarMatch = line.match(/^(\s*-\s+)(.+)$/)
    if (listScalarMatch && !/^[A-Za-z_][\w_-]*\s*:/.test(listScalarMatch[2]!)) {
      const prefix = listScalarMatch[1]!
      const { value, comment } = splitYamlValueAndComment(listScalarMatch[2]!)
      if (YAML_UNION_SCALAR_PATTERN.test(value.trim())) {
        result.push(`${prefix}${JSON.stringify(value.trim())}${comment ? ` ${comment}` : ''}`)
        continue
      }
    }

    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Quote plain YAML scalars that begin with reserved indicator characters.
 *
 * YAML rejects plain one-line scalars that begin with reserved indicators such
 * as backticks or `@`. Models sometimes emit values like:
 *   question: `repo_git_mutex` behavior?
 *   - @trace/span-id
 * This repair wraps the full visible scalar in double quotes while preserving
 * trailing comments and skipping already-safe constructs.
 */
export function repairYamlReservedIndicatorScalars(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const MAPPING_BLOCK_SCALAR_PATTERN = MAPPING_BLOCK_SCALAR_HEADER
  const LIST_BLOCK_SCALAR_PATTERN = LIST_BLOCK_SCALAR_HEADER
  const RESERVED_INDICATOR_START = /^[`@]/
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    if (blockScalarBaseIndent >= 0) {
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    if (MAPPING_BLOCK_SCALAR_PATTERN.test(trimmed) || LIST_BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = indent
      result.push(line)
      continue
    }

    const mappingMatch = line.match(/^(\s*(?:-\s+)?[A-Za-z_][\w_-]*\s*:\s+)(.+)$/)
    if (mappingMatch) {
      const prefix = mappingMatch[1]!
      const { value, comment } = splitYamlValueAndComment(mappingMatch[2]!)
      const trimmedValue = value.trim()
      if (!RESERVED_INDICATOR_START.test(trimmedValue)) {
        result.push(line)
        continue
      }

      result.push(`${prefix}${JSON.stringify(trimmedValue)}${comment ? ` ${comment}` : ''}`)
      continue
    }

    const listScalarMatch = line.match(/^(\s*-\s+)(.+)$/)
    if (listScalarMatch && !/^[A-Za-z_][\w_-]*\s*:/.test(listScalarMatch[2]!)) {
      const prefix = listScalarMatch[1]!
      const { value, comment } = splitYamlValueAndComment(listScalarMatch[2]!)
      const trimmedValue = value.trim()
      if (!RESERVED_INDICATOR_START.test(trimmedValue)) {
        result.push(line)
        continue
      }

      result.push(`${prefix}${JSON.stringify(trimmedValue)}${comment ? ` ${comment}` : ''}`)
      continue
    }

    result.push(line)
  }

  return result.join('\n')
}

function collectMultilineSingleQuotedFreeText(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { endIndex: number; contentLines: string[] } | null {
  const firstLine = lines[startIndex]
  if (!firstLine) return null

  const freeTextMatch = firstLine.match(/^(\s*(?:-\s+)?free_text\s*:\s*)'(.*)$/)
  if (!freeTextMatch) return null

  const firstValuePart = freeTextMatch[2]!
  if (firstValuePart.trimEnd().endsWith("'")) {
    return null
  }

  const rawContentLines = [firstValuePart]
  const continuationIndents: number[] = []
  let endIndex = startIndex

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0

    if (trimmed && indent <= parentIndent) {
      break
    }

    rawContentLines.push(line)
    endIndex = index
    if (trimmed) {
      continuationIndents.push(indent)
    }
  }

  if (endIndex === startIndex) {
    return null
  }

  const contentBaseIndent = continuationIndents.length > 0
    ? Math.min(...continuationIndents)
    : parentIndent + 2

  const contentLines = rawContentLines.map((line, index) => {
    if (index === 0) return line
    if (!line.trim()) return ''
    return line.slice(Math.min(contentBaseIndent, line.length))
  })

  const lastIndex = contentLines.length - 1
  contentLines[lastIndex] = contentLines[lastIndex]!.replace(/'$/, '')

  return {
    endIndex,
    contentLines,
  }
}

/**
 * Strip markdown code fences wrapping YAML/JSON content.
 *
 * Models sometimes wrap their entire structured output in ```yaml ... ```
 * or similar fences. Returns the inner content if wrapped, or the input
 * unchanged if not wrapped.
 */
export function stripCodeFences(content: string): string {
  const trimmed = content.trim()
  const openMatch = trimmed.match(/^```(?:yaml|yml|jsonl|json)?\s*\n/)
  if (!openMatch) return content
  const closeMatch = trimmed.match(/\n\s*```\s*$/)
  if (!closeMatch) return content
  return trimmed.slice(openMatch[0].length, closeMatch.index!)
}

/**
 * Repair YAML where multiple mapping keys appear on a single line.
 *
 * Models sometimes emit all keys inline, e.g.:
 *   batch_number: 4 progress: current: 4 total: 17 is_final_free_form: false
 * This function splits them onto separate lines with correct indentation,
 * handling both flat siblings and nested mappings.
 */
interface YamlInlineKeyRepairOptions {
  nestedMappingChildren?: Record<string, readonly string[]>
}

export function repairYamlInlineKeys(yaml: string, options?: YamlInlineKeyRepairOptions): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  const nestedMappingChildren = buildNormalizedNestedMappingChildren(options?.nestedMappingChildren)
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // A block scalar's body is text, not YAML. Skipping only the header line
    // left the body tokenized like any other line, so
    // `description: |` / `  key1: value1 key2: value2` was emitted as two
    // lines — a newline invented inside a value a model wrote, which is the one
    // thing a repair must never do.
    if (blockScalarBaseIndent >= 0) {
      if (getLineIndent(line) > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    // Skip block scalar indicators
    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = getLineIndent(line)
      result.push(line)
      continue
    }

    const indent = (line.match(/^(\s*)/) ?? [''])[0]
    const hasDash = /^\s*-\s+/.test(line)
    const content = hasDash ? line.replace(/^\s*-\s+/, '') : trimmed
    const dashPrefix = hasDash ? (line.match(/^(\s*-\s+)/) ?? [''])[1]! : ''

    const tokens = tokenizeInlineKeys(content)
    if (!tokens || tokens.length <= 1) {
      result.push(line)
      continue
    }

    // Build nested structure from flat tokens
    const structured = buildNestedStructure(tokens, nestedMappingChildren)

    // Emit onto separate lines
    const baseIndent = hasDash ? indent + '  ' : indent
    result.push(...emitInlineEntries(structured, baseIndent, hasDash ? dashPrefix : undefined))
  }

  return result.join('\n')
}

interface InlineKVToken { key: string; value: string; sequenceStart: boolean }
interface InlineKVLeaf { key: string; value: string }
interface InlineKVParent { key: string; children: InlineKVEntry[] }
interface InlineKVSequenceParent { key: string; items: InlineKVSequenceItem[] }
interface InlineKVSequenceItem { value?: string; children?: InlineKVEntry[] }
type InlineKVEntry = InlineKVLeaf | InlineKVParent | InlineKVSequenceParent

type NormalizedNestedMappingChildren = Map<string, Set<string>>

function buildNormalizedNestedMappingChildren(
  nestedMappingChildren: Record<string, readonly string[]> | undefined,
): NormalizedNestedMappingChildren {
  const normalized = new Map<string, Set<string>>()

  for (const [parentKey, childKeys] of Object.entries(nestedMappingChildren ?? {})) {
    const normalizedParent = normalizeYamlRepairKey(parentKey)
    if (!normalizedParent) continue
    const normalizedChildren = new Set(
      childKeys
        .map(childKey => normalizeYamlRepairKey(childKey))
        .filter(Boolean),
    )
    if (normalizedChildren.size > 0) {
      normalized.set(normalizedParent, normalizedChildren)
    }
  }

  return normalized
}

/**
 * Tokenize text into key-value pairs. Returns null if the text
 * doesn't look like inline YAML keys (e.g. it's a normal value with spaces).
 */
function tokenizeInlineKeys(text: string): InlineKVToken[] | null {
  const keyMatches = collectInlineKeyMatches(text)

  if (keyMatches.length < 2) return null
  // Text must begin with a key
  if (keyMatches[0]!.start !== 0) return null

  const tokens: InlineKVToken[] = []
  for (let i = 0; i < keyMatches.length; i++) {
    const km = keyMatches[i]!
    const nextMatch = i + 1 < keyMatches.length ? keyMatches[i + 1]! : null
    const nextStart = nextMatch
      ? nextMatch.sequenceMarkerStart ?? nextMatch.start
      : text.length
    tokens.push({
      key: km.key,
      value: text.slice(km.valueStart, nextStart).trim(),
      sequenceStart: km.sequenceStart,
    })
  }

  // Validate: all non-empty values must be simple (number, boolean, quoted, single word).
  // The final free-text field may contain spaces because no later inline key
  // can be swallowed after it.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!token.value) continue
    if (token.value === '-') continue
    if (parseInlineScalarSequence(token.value)) continue
    if (index === tokens.length - 1 && isInlineFreeTextFinalKey(token.key)) continue
    if (!isInlineSimpleValue(token.value)) return null
  }

  return tokens
}

/**
 * Group flat tokens into a nested structure.
 * A key with an empty value is treated as a parent whose children are the
 * following keys. Children end when a key's naming style changes (compound
 * vs simple) or when another parent key is encountered.
 */
function buildNestedStructure(
  tokens: InlineKVToken[],
  nestedMappingChildren: NormalizedNestedMappingChildren,
): InlineKVEntry[] {
  const result: InlineKVEntry[] = []
  let i = 0

  while (i < tokens.length) {
    const consumed = consumeInlineEntry(tokens, i, nestedMappingChildren)
    result.push(consumed.entry)
    i = consumed.nextIndex
  }

  return result
}

function consumeInlineEntry(
  tokens: InlineKVToken[],
  index: number,
  nestedMappingChildren: NormalizedNestedMappingChildren,
): { entry: InlineKVEntry; nextIndex: number } {
  const token = tokens[index]!
  const scalarSequence = parseInlineScalarSequence(token.value)
  if (scalarSequence) {
    return {
      entry: {
        key: token.key,
        items: scalarSequence.map(value => ({ value })),
      },
      nextIndex: index + 1,
    }
  }

  if ((token.value === '' || token.value === '-') && tokens[index + 1]?.sequenceStart) {
    return consumeInlineSequenceParent(tokens, index, nestedMappingChildren)
  }

  const knownChildren = nestedMappingChildren.get(normalizeYamlRepairKey(token.key))
  if (knownChildren && index + 1 < tokens.length) {
    const children: InlineKVEntry[] = []
    let cursor = index + 1

    while (cursor < tokens.length && knownChildren.has(normalizeYamlRepairKey(tokens[cursor]!.key))) {
      const consumed = consumeInlineEntry(tokens, cursor, nestedMappingChildren)
      children.push(consumed.entry)
      cursor = consumed.nextIndex
    }

    if (children.length > 0 && (token.value === '' || token.value === tokens[index + 1]?.key)) {
      return {
        entry: { key: token.key, children },
        nextIndex: cursor,
      }
    }
  }

  if (token.value === '' && index + 1 < tokens.length) {
    return consumeFallbackMappingParent(tokens, index)
  }

  return { entry: { key: token.key, value: token.value }, nextIndex: index + 1 }
}

function consumeFallbackMappingParent(
  tokens: InlineKVToken[],
  index: number,
): { entry: InlineKVEntry; nextIndex: number } {
  const token = tokens[index]!
  const children: InlineKVEntry[] = []
  const firstChildStyle = nameHasUnderscore(tokens[index + 1]!.key)
  let cursor = index + 1

  while (cursor < tokens.length) {
    const child = tokens[cursor]!
    if (child.value === '' || child.sequenceStart) break
    const childStyle = nameHasUnderscore(child.key)
    if (children.length > 0 && childStyle !== firstChildStyle) break
    children.push({ key: child.key, value: child.value })
    cursor += 1
  }

  if (children.length > 0) {
    return {
      entry: { key: token.key, children },
      nextIndex: cursor,
    }
  }

  return { entry: { key: token.key, value: token.value }, nextIndex: index + 1 }
}

function consumeInlineSequenceParent(
  tokens: InlineKVToken[],
  index: number,
  nestedMappingChildren: NormalizedNestedMappingChildren,
): { entry: InlineKVEntry; nextIndex: number } {
  const token = tokens[index]!
  const items: InlineKVSequenceItem[] = []
  let currentItem: InlineKVEntry[] | null = null
  let cursor = index + 1

  while (cursor < tokens.length) {
    const child = tokens[cursor]!
    if (child.sequenceStart) {
      currentItem = []
      items.push({ children: currentItem })
    } else if (!currentItem || (currentItem.length > 0 && isKnownInlineMappingParent(child.key, nestedMappingChildren))) {
      break
    }

    const consumed = consumeInlineEntry(tokens, cursor, nestedMappingChildren)
    currentItem!.push(consumed.entry)
    cursor = consumed.nextIndex
  }

  if (items.length > 0) {
    return {
      entry: { key: token.key, items },
      nextIndex: cursor,
    }
  }

  return { entry: { key: token.key, value: token.value }, nextIndex: index + 1 }
}

function isKnownInlineMappingParent(
  key: string,
  nestedMappingChildren: NormalizedNestedMappingChildren,
): boolean {
  return nestedMappingChildren.has(normalizeYamlRepairKey(key))
}

function emitInlineEntries(entries: InlineKVEntry[], baseIndent: string, firstLinePrefix?: string): string[] {
  const lines: string[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const prefix = index === 0 && firstLinePrefix ? firstLinePrefix : baseIndent
    lines.push(...emitInlineEntry(entries[index]!, prefix, baseIndent))
  }

  return lines
}

function emitInlineEntry(entry: InlineKVEntry, prefix: string, childBaseIndent: string): string[] {
  if ('items' in entry) {
    const lines = [`${prefix}${entry.key}:`]
    for (const item of entry.items) {
      if (typeof item.value === 'string') {
        lines.push(`${childBaseIndent}  - ${item.value}`)
        continue
      }

      const children = item.children ?? []
      if (children.length === 0) {
        lines.push(`${childBaseIndent}  -`)
        continue
      }

      const [firstChild, ...rest] = children
      lines.push(...emitInlineEntry(firstChild!, `${childBaseIndent}  - `, `${childBaseIndent}    `))
      for (const child of rest) {
        lines.push(...emitInlineEntry(child, `${childBaseIndent}    `, `${childBaseIndent}    `))
      }
    }
    return lines
  }

  if ('children' in entry) {
    const lines = [`${prefix}${entry.key}:`]
    for (const child of entry.children) {
      lines.push(...emitInlineEntry(child, `${childBaseIndent}  `, `${childBaseIndent}  `))
    }
    return lines
  }

  return [entry.value ? `${prefix}${entry.key}: ${entry.value}` : `${prefix}${entry.key}:`]
}

function collectInlineKeyMatches(text: string): Array<{
  key: string
  start: number
  valueStart: number
  sequenceStart: boolean
  sequenceMarkerStart?: number
}> {
  const matches: Array<{
    key: string
    start: number
    valueStart: number
    sequenceStart: boolean
    sequenceMarkerStart?: number
  }> = []
  let quote: '"' | '\'' | null = null

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!

    if (quote) {
      if (char === quote) {
        if (quote === '\'' && text[index + 1] === '\'') {
          index += 1
          continue
        }
        if (quote === '"' && hasOddTrailingBackslashes(text, index)) {
          continue
        }
        quote = null
      }
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (!isInlineKeyStart(text, index)) continue

    let cursor = index + 1
    while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor]!)) {
      cursor += 1
    }

    let colonCursor = cursor
    while (colonCursor < text.length && /\s/.test(text[colonCursor]!)) {
      colonCursor += 1
    }
    if (text[colonCursor] !== ':') continue
    const afterColon = text[colonCursor + 1]
    if (afterColon !== undefined && !/\s/.test(afterColon)) continue

    let valueStart = colonCursor + 1
    while (valueStart < text.length && /\s/.test(text[valueStart]!)) {
      valueStart += 1
    }

    const sequenceMarkerStart = getInlineSequenceMarkerBefore(text, index)
    matches.push({
      key: text.slice(index, cursor),
      start: index,
      valueStart,
      sequenceStart: sequenceMarkerStart !== null,
      ...(sequenceMarkerStart !== null ? { sequenceMarkerStart } : {}),
    })
    index = valueStart - 1
  }

  return matches
}

function isInlineKeyStart(text: string, index: number): boolean {
  const char = text[index]
  if (!char || !/[a-z_]/.test(char)) return false
  if (index === 0) return true

  const previous = text[index - 1]!
  if (/\s/.test(previous)) return true
  if (previous === '-' && (index === 1 || /\s/.test(text[index - 2]!))) return true
  return false
}

function getInlineSequenceMarkerBefore(text: string, index: number): number | null {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(text[cursor]!)) {
    cursor -= 1
  }

  return text[cursor] === '-' && (cursor === 0 || /\s/.test(text[cursor - 1]!)) ? cursor : null
}

function nameHasUnderscore(name: string): boolean {
  return name.includes('_')
}

const INLINE_FREE_TEXT_FINAL_KEYS = new Set([
  'content',
  'description',
  'prompt',
  'question',
  'rationale',
  'summary',
  'text',
])

function isInlineFreeTextFinalKey(key: string): boolean {
  return INLINE_FREE_TEXT_FINAL_KEYS.has(normalizeYamlRepairKey(key))
}

function parseInlineScalarSequence(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('- ')) return null

  const values: string[] = []
  let quote: '"' | '\'' | null = null
  let entryStart = -1
  let cursor = 0

  while (cursor < trimmed.length) {
    const char = trimmed[cursor]!

    if (quote) {
      if (char === quote) {
        if (quote === '\'' && trimmed[cursor + 1] === '\'') {
          cursor += 2
          continue
        }
        if (quote === '"' && hasOddTrailingBackslashes(trimmed, cursor)) {
          cursor += 1
          continue
        }
        quote = null
      }
      cursor += 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      cursor += 1
      continue
    }

    if (char === '-' && trimmed[cursor + 1] === ' ' && (cursor === 0 || /\s/.test(trimmed[cursor - 1]!))) {
      if (entryStart >= 0) {
        const value = trimmed.slice(entryStart, cursor).trim()
        if (!isInlineSimpleValue(value)) return null
        values.push(value)
      }
      entryStart = cursor + 2
      cursor += 2
      continue
    }

    cursor += 1
  }

  if (entryStart < 0) return null
  const finalValue = trimmed.slice(entryStart).trim()
  if (!finalValue || !isInlineSimpleValue(finalValue)) return null
  values.push(finalValue)
  return values.length > 0 ? values : null
}

function isInlineSimpleValue(text: string): boolean {
  if (/^-?\d+(\.\d+)?$/.test(text)) return true
  if (/^(true|false|yes|no|null|~)$/i.test(text)) return true
  if (/^"(?:[^"\\]|\\.)*"$/.test(text) || /^'(?:[^']|'')*'$/.test(text)) return true
  if (/^\[[\s\S]*\]$/.test(text) || /^\{[\s\S]*\}$/.test(text)) return true
  if (/^[^\s:]+$/.test(text)) return true
  return false
}

function quoteYamlPlainScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function looksLikeHeaderStyleListScalar(value: string): boolean {
  return /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+:\s+\S/.test(value)
}

// Hoisted; tested once per line. `SAFE_VALUE_START` keeps its own name here
// rather than being shared: §13.7 records that the three constants spelled
// `SAFE_VALUE_START` in this module are not the same contract.
const WRAPPED_LIST_SCALAR_PATTERN = /^(\s*)-\s+(.+)$/
const WRAPPED_LIST_SCALAR_STRUCTURAL_CONTINUATION_PATTERN = /^(?:-\s+|[A-Za-z_][\w-]*\s*:|[>|][+-]?\s*$)/
const WRAPPED_LIST_SCALAR_SAFE_VALUE_START = /^["'[{>|&*!#]/

/**
 * Repair prose list scalars that contain colon-space and wrap onto deeper lines.
 *
 * A model can emit prose such as:
 *
 *   - `Object.getOwnPropertyDescriptor()` reports `writable: false`, and
 *     `configurable: false`.
 *
 * YAML reads the colon-space on the first line as mapping syntax, leaving the
 * wrapped continuation invalid. When the list item cannot be a normal mapping
 * and every continuation is prose-shaped, convert the existing lines to a
 * folded block scalar. This preserves the model's text and YAML's intended
 * space-folding without inventing or discarding content.
 */
export function repairYamlWrappedPlainListScalars(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const match = line.match(WRAPPED_LIST_SCALAR_PATTERN)
    if (!match) {
      result.push(line)
      continue
    }

    const dashIndent = match[1]!.length
    const value = match[2]!
    const looksLikeListItemMapping = /^[A-Za-z_][\w-]*\s*:\s+/.test(value)
    if (
      WRAPPED_LIST_SCALAR_SAFE_VALUE_START.test(value)
      || !/:\s/.test(value)
      || (looksLikeListItemMapping && !looksLikeHeaderStyleListScalar(value))
    ) {
      result.push(line)
      continue
    }

    const continuationLines: string[] = []
    let nextIndex = index + 1
    let ambiguous = false
    for (; nextIndex < lines.length; nextIndex += 1) {
      const continuation = lines[nextIndex]!
      const trimmed = continuation.trim()
      if (!trimmed) {
        ambiguous = true
        break
      }

      const continuationIndent = continuation.match(/^(\s*)/)?.[1]?.length ?? 0
      if (continuationIndent <= dashIndent) break
      if (trimmed.startsWith('#') || WRAPPED_LIST_SCALAR_STRUCTURAL_CONTINUATION_PATTERN.test(trimmed)) {
        ambiguous = true
        break
      }
      continuationLines.push(continuation)
    }

    if (continuationLines.length === 0 || ambiguous) {
      result.push(line)
      continue
    }

    result.push(`${match[1]}- >-`)
    result.push(`${' '.repeat(dashIndent + 2)}${value}`)
    result.push(...continuationLines)
    index = nextIndex - 1
  }

  return result.join('\n')
}

/**
 * Repair YAML plain scalars that contain `: ` (colon-space).
 *
 * In YAML, a plain scalar value must not contain `: ` because parsers
 * interpret it as a nested mapping entry. Models frequently produce
 * unquoted values like `rationale: some rules: here` which breaks parsing.
 * This function wraps such values in double quotes.
 */
export function repairYamlPlainScalarColons(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []

  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  // Skip values that are already safe: quoted, block scalar, flow, anchor, tag, or comment
  const SAFE_VALUE_START = /^["'[{>|&*!#]/
  let blockScalarBaseIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()

    // Blank / comment lines pass through
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    // Track block-scalar continuation: any line indented deeper than the key
    if (blockScalarBaseIndent >= 0) {
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
      if (indent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      // Left the block scalar
      blockScalarBaseIndent = -1
    }

    // Match `key: value` — capture indent+key vs value
    // Works for both top-level and nested keys, including list item first keys
    const mappingMatch = line.match(/^(\s*(?:-\s+)?)([A-Za-z_][\w_-]*\s*:\s+)(.+)$/)
    if (mappingMatch) {
      const prefix = mappingMatch[1]! + mappingMatch[2]!
      const value = mappingMatch[3]!

      // Detect block scalar indicator on this line
      if (BLOCK_SCALAR_PATTERN.test(line.trimEnd())) {
        blockScalarBaseIndent = (line.match(/^(\s*)/)?.[1]?.length ?? 0)
        result.push(line)
        continue
      }

      // Skip already-safe values
      if (SAFE_VALUE_START.test(value)) {
        result.push(line)
        continue
      }

      // A trailing comment is not part of the scalar, and cannot be what broke
      // the parse, so split it off before quoting and put it back unchanged.
      const { value: scalarValue, comment } = splitYamlValueAndComment(value)

      // Check if the value contains a problematic `: ` or ends with `:`
      if (/:\s/.test(scalarValue) || scalarValue.endsWith(':')) {
        result.push(`${prefix}${quoteYamlPlainScalar(scalarValue)}${comment ? ` ${comment}` : ''}`)
        continue
      }
    }

    const listScalarMatch = line.match(/^(\s*-\s+)(.+)$/)
    if (listScalarMatch) {
      const prefix = listScalarMatch[1]!
      const value = listScalarMatch[2]!
      const looksLikeListItemMapping = /^[A-Za-z_][\w_-]*\s*:\s+/.test(value)

      // A block scalar opened as a sequence entry. `|` is a safe value start,
      // so this line was pushed and skipped — and the arming at the bottom of
      // the loop was skipped with it, leaving the body to be quoted line by
      // line. Recognising the header was not enough; it has to arm here too.
      if (BLOCK_SCALAR_HEADER.test(trimmed)) {
        blockScalarBaseIndent = getLineIndent(line)
        result.push(line)
        continue
      }

      if (SAFE_VALUE_START.test(value)) {
        result.push(line)
        continue
      }

      const { value: scalarValue, comment } = splitYamlValueAndComment(value)

      if (
        looksLikeHeaderStyleListScalar(scalarValue)
        || (!looksLikeListItemMapping && (/:\s/.test(scalarValue) || scalarValue.endsWith(':')))
      ) {
        result.push(`${prefix}${quoteYamlPlainScalar(scalarValue)}${comment ? ` ${comment}` : ''}`)
        continue
      }

      if (looksLikeListItemMapping) {
        result.push(line)
        continue
      }
    }

    // Bare `key:` with block scalar on next line
    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = (line.match(/^(\s*)/)?.[1]?.length ?? 0)
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Repair YAML values with unclosed double-quotes.
 *
 * Models sometimes emit `key: "value` without a closing `"`. The YAML parser
 * then treats all subsequent lines as part of the quoted scalar, swallowing
 * sibling keys and list items. This function detects unclosed double-quoted
 * values and appends a closing `"` when the next non-blank line is clearly a
 * separate YAML structural element (a list item, sibling key, code fence,
 * document marker, or EOF).
 */
export function repairYamlUnclosedQuotes(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  const BLOCK_SCALAR_PATTERN = BLOCK_SCALAR_HEADER
  // Match `key: "value` with optional leading `- ` for list item first keys
  const QUOTED_VALUE_PATTERN = /^(\s*(?:-\s+)?[A-Za-z_][\w_-]*\s*:\s+)"(.*)$/
  const LIST_QUOTED_VALUE_PATTERN = /^(\s*-\s+)"(.*)$/
  let blockScalarBaseIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    // Blank / comment lines pass through
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    const lineIndent = (line.match(/^(\s*)/) ?? [''])[0].length

    // Block-scalar continuation tracking
    if (blockScalarBaseIndent >= 0) {
      if (lineIndent > blockScalarBaseIndent) {
        result.push(line)
        continue
      }
      blockScalarBaseIndent = -1
    }

    // Detect block scalar indicator — skip these lines from quote repair
    if (BLOCK_SCALAR_PATTERN.test(trimmed)) {
      blockScalarBaseIndent = lineIndent
      result.push(line)
      continue
    }

    // Mapping values and sequence entries differ only in how the opening quote
    // is found; what follows it is judged identically. The two matchers are
    // tried in the same order as before, so a line both could match — there is
    // none, one requires `key:` and the other a bare `- ` — would still be
    // handled by the mapping form first.
    const quotedMatch = line.match(QUOTED_VALUE_PATTERN) ?? line.match(LIST_QUOTED_VALUE_PATTERN)
    if (quotedMatch) {
      const valueAfterOpenQuote = quotedMatch[2]!
      // If the value has an even number of unescaped double-quotes after the
      // opening one, the total is odd — meaning the opening quote is unclosed.
      if (countUnescapedDoubleQuotes(valueAfterOpenQuote) % 2 === 0) {
        const nextLine = findNextNonBlankLine(lines, i + 1)
        if (nextLine === null || looksLikeYamlStructuralLine(nextLine, lineIndent)) {
          result.push(line + '"')
          continue
        }
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

function countUnescapedDoubleQuotes(value: string): number {
  let count = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '"') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) {
      backslashes++
    }
    if (backslashes % 2 === 0) count++
  }
  return count
}

function findNextNonBlankLine(lines: string[], startIndex: number): string | null {
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i]!.trim()) return lines[i]!
  }
  return null
}

function looksLikeYamlStructuralLine(line: string, currentIndent: number): boolean {
  const trimmed = line.trim()
  const lineIndent = (line.match(/^(\s*)/) ?? [''])[0].length

  // New list item at same or lesser indent (with some tolerance)
  if (/^\s*-\s+\S/.test(line) && lineIndent <= currentIndent + 2) return true

  // Mapping key at same or lesser indent
  if (/^\s*[A-Za-z_][\w_-]*\s*:/.test(line) && lineIndent <= currentIndent) return true

  // Code fence
  if (trimmed.startsWith('```')) return true

  // YAML document markers
  if (trimmed === '---' || trimmed === '...') return true

  return false
}
