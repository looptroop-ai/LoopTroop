import * as jsYaml from 'js-yaml'
import type { PromptPart } from '../opencode/types'
import { repairYamlDoubleQuotedInvalidEscapes, repairYamlDoubleQuotedScalarInnerQuotes, repairYamlDuplicateKeys, repairYamlFreeTextScalars, repairYamlIndentation, repairYamlInlineKeys, repairYamlInlineSequenceParents, repairYamlListDashSpace, repairYamlMappingKeyColonSpace, repairYamlNestedMappingChildren, repairYamlPlainScalarColons, repairYamlQuotedScalarFragments, repairYamlReservedIndicatorScalars, repairYamlSequenceEntryIndent, repairYamlSequenceItemPrimaryKeys, repairYamlTypeUnionScalars, repairYamlUnclosedQuotes, repairYamlWrappedPlainListScalars, stripCodeFences, type YamlSequenceItemPrimaryKeyOptions, type YamlSequenceItemPrimaryKeyRepair } from '@shared/yamlRepair'
import { isRecord } from '@shared/typeGuards'
import { stripTranscriptPrefixes as stripSharedTranscriptPrefixes } from '@shared/transcriptPrefix'

export { isRecord }


export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The shared strip, plus the trim this module's callers have always relied on. */
export function stripTranscriptPrefixes(content: string): string {
  return stripSharedTranscriptPrefixes(content).trim()
}

export function addCandidate(target: string[], seen: Set<string>, value: string | null | undefined) {
  const normalized = value?.trim()
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  target.push(normalized)
}

export function collectStructuredCandidates(
  rawContent: string,
  options?: {
    tags?: string[]
    topLevelHints?: string[]
  },
): string[] {
  const raw = rawContent.trim()
  const stripped = stripTranscriptPrefixes(raw)
  const candidates: string[] = []
  const seen = new Set<string>()

  addCandidate(candidates, seen, raw)
  addCandidate(candidates, seen, stripped)

  for (const source of [raw, stripped]) {
    for (const match of source.matchAll(/```(?:yaml|yml|jsonl|json)?\s*([\s\S]*?)\s*```/gi)) {
      addCandidate(candidates, seen, stripTranscriptPrefixes(match[1] ?? ''))
      addCandidate(candidates, seen, match[1] ?? '')
    }

    for (const tag of options?.tags ?? []) {
      const tagPattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')
      for (const match of source.matchAll(tagPattern)) {
        addCandidate(candidates, seen, stripTranscriptPrefixes(match[1] ?? ''))
        addCandidate(candidates, seen, match[1] ?? '')
      }
    }

    if (options?.topLevelHints?.length) {
      const lines = source.split('\n')
      const index = lines.findIndex((line) => {
        const trimmed = line.trim().toLowerCase()
        return options.topLevelHints!.some((hint) => trimmed.startsWith(`${hint.toLowerCase()}:`))
      })
      if (index >= 0) {
        addCandidate(candidates, seen, lines.slice(index).join('\n'))
      }

      for (const candidate of collectGluedTopLevelHintCandidates(lines, options.topLevelHints)) {
        addCandidate(candidates, seen, candidate)
      }
    }
  }

  return candidates
}

function collectGluedTopLevelHintCandidates(lines: string[], topLevelHints: string[]): string[] {
  const candidates: string[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    for (const startIndex of findGluedTopLevelHintStarts(line, topLevelHints)) {
      const candidateLines = lines.slice(lineIndex)
      candidateLines[0] = line.slice(startIndex)
      candidates.push(candidateLines.join('\n'))
    }
  }

  return candidates
}

function findGluedTopLevelHintStarts(line: string, topLevelHints: string[]): number[] {
  const starts: number[] = []

  for (const hint of topLevelHints) {
    const trimmedHint = hint.trim()
    if (!trimmedHint) continue

    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${escapeRegExp(trimmedHint)}\\s*:)`, 'gi')
    for (const match of line.matchAll(pattern)) {
      const boundary = match[1] ?? ''
      const start = (match.index ?? 0) + boundary.length
      if (start === 0) continue
      if (!looksLikeRecoverableGluedPrefix(line.slice(0, start))) continue
      starts.push(start)
    }
  }

  return [...new Set(starts)].sort((left, right) => left - right)
}

function looksLikeRecoverableGluedPrefix(prefix: string): boolean {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed.length > 240) return false
  if (!/[A-Za-z]/.test(trimmed)) return false
  if (/```|<\/?[A-Za-z_][A-Za-z0-9_-]*\s*\/?>/.test(trimmed)) return false
  return true
}

export function collectTaggedCandidates(rawContent: string, tag: string): string[] {
  const raw = rawContent.trim()
  const stripped = stripTranscriptPrefixes(raw)
  const candidates: string[] = []
  const seen = new Set<string>()
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')

  for (const source of [raw, stripped]) {
    for (const match of source.matchAll(pattern)) {
      const inner = match[1] ?? ''
      addCandidate(candidates, seen, inner)
      addCandidate(candidates, seen, stripTranscriptPrefixes(inner))
      for (const nested of collectStructuredCandidates(inner)) {
        addCandidate(candidates, seen, nested)
      }
    }
  }

  // Fallback: if there's an opening tag but no closing tag (truncated output),
  // extract everything after the last opening tag as a candidate
  if (candidates.length === 0) {
    const openPattern = new RegExp(`<${tag}>`, 'gi')
    for (const source of [raw, stripped]) {
      const openMatches = [...source.matchAll(openPattern)]
      if (openMatches.length > 0) {
        const lastOpen = openMatches[openMatches.length - 1]!
        const afterTag = source.slice(lastOpen.index! + lastOpen[0].length)
        addCandidate(candidates, seen, afterTag)
        addCandidate(candidates, seen, stripTranscriptPrefixes(afterTag))
        for (const nested of collectStructuredCandidates(afterTag)) {
          addCandidate(candidates, seen, nested)
        }
      }
    }
  }

  return candidates
}

/** Remove lines that are purely an XML tag — safe because real YAML string values won't be on a line alone as a bare tag */
export function stripSpuriousXmlTags(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*<\/?[a-zA-Z_][a-zA-Z0-9_-]*\s*\/?\s*>\s*$/.test(line))
    .join('\n')
}

interface ParseYamlOrJsonCandidateOptions {
  nestedMappingChildren?: Record<string, readonly string[]>
  sequenceItemPrimaryKeys?: YamlSequenceItemPrimaryKeyOptions
  allowTrailingTerminalNoise?: boolean
  repairWarnings?: string[]
}

const TERMINAL_NOISE_WARNING = 'Trimmed trailing terminal noise after the complete structured artifact.'
const ORPHAN_CLOSING_CODE_FENCE_WARNING = 'Trimmed orphan trailing closing code fence after the structured artifact.'
const MARKDOWN_CODE_FENCE_WARNING = 'Unwrapped markdown code fence wrapping the YAML payload.'
const NESTED_MAPPING_CHILDREN_WARNING = 'Repaired inconsistent YAML indentation for nested mapping children.'
const XML_STYLE_TAGS_WARNING = 'Stripped XML-style tags from the payload before parsing.'
const CANDIDATE_RECOVERY_WARNING = 'Recovered the structured artifact from surrounding transcript or wrapper text before validation.'
const WRAPPER_KEY_WARNING = 'Removed wrapper key from top level.'
const INLINE_YAML_WARNING = 'Repaired inline YAML sequence or mapping syntax before parsing.'
const MAPPING_KEY_COLON_SPACE_WARNING = 'Repaired YAML mapping keys missing a space after colon before parsing.'
const WRAPPED_PLAIN_LIST_SCALAR_WARNING = 'Folded wrapped YAML list scalar text containing colon-space before reparsing.'
const PLAIN_SCALAR_COLON_WARNING = 'Quoted YAML plain scalar values containing colon-space before reparsing.'
const QUOTED_SCALAR_WARNING = 'Repaired improperly quoted YAML scalar value.'
const UNBALANCED_QUOTE_WARNING = 'Fixed unbalanced YAML quote before reparsing.'
const RESERVED_INDICATOR_SCALAR_WARNING = 'Quoted plain YAML scalars that began with reserved indicator characters (` or @) before reparsing.'
const DOUBLE_QUOTED_ESCAPE_WARNING = 'Escaped invalid YAML double-quoted scalar backslash sequences before reparsing.'
const FREE_TEXT_SCALAR_WARNING = 'Repaired YAML free_text scalar formatting before parsing.'
const LIST_DASH_SPACE_WARNING = 'Inserted the missing space after a YAML list dash before parsing.'
const DUPLICATE_KEYS_WARNING = 'Removed duplicate YAML mapping keys before parsing.'

function appendRepairWarningOnce(repairWarnings: string[] | undefined, warning: string) {
  if (!repairWarnings?.includes(warning)) {
    repairWarnings?.push(warning)
  }
}

function formatQuotedList(values: string[]): string {
  if (values.length === 0) return ''
  if (values.length === 1) return values[0]!
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`
}

function normalizeWrapperPath(path: string[] | undefined): string[] {
  return Array.isArray(path)
    ? path
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
    : []
}

function buildWrapperKeyRepairWarning(path?: string[]): string {
  const normalizedPath = normalizeWrapperPath(path)
  if (normalizedPath.length === 0) return WRAPPER_KEY_WARNING
  if (normalizedPath.length === 1) {
    return `Removed wrapper key "${normalizedPath[0]}" from top level.`
  }
  return `Removed wrapper key chain "${normalizedPath.join(' -> ')}" from top level.`
}

function buildXmlStyleTagsWarning(tags?: string[]): string {
  const normalizedTags = Array.isArray(tags)
    ? [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
    : []

  if (normalizedTags.length === 0) return XML_STYLE_TAGS_WARNING
  return `Stripped XML-style tags ${formatQuotedList(normalizedTags)} from the payload before parsing.`
}

function escapeWarningValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildSequenceItemPrimaryKeyRepairWarning(repair: YamlSequenceItemPrimaryKeyRepair): string {
  return `Repaired YAML sequence entry under "${escapeWarningValue(repair.parentKey)}" at line ${repair.line}: treated bare item "${escapeWarningValue(repair.value)}" as ${repair.primaryKey} before parsing.`
}

function findWrapperPath(
  value: unknown,
  preferredKeys: string[],
  allowSingleKeyFallback: boolean,
  depth: number = 0,
): string[] | null {
  if (!isRecord(value) || depth > 4) return null

  for (const [key, nested] of Object.entries(value)) {
    if (!preferredKeys.includes(normalizeKey(key))) continue
    const nestedPath = findWrapperPath(nested, preferredKeys, allowSingleKeyFallback, depth + 1)
    return nestedPath ? [key, ...nestedPath] : [key]
  }

  const keys = Object.keys(value)
  if (allowSingleKeyFallback && keys.length === 1) {
    const nestedPath = findWrapperPath(value[keys[0]!], preferredKeys, allowSingleKeyFallback, depth + 1)
    return nestedPath ? [keys[0]!, ...nestedPath] : [keys[0]!]
  }

  return null
}

export function findMaybeUnwrappedWrapperPath(value: unknown, preferredKeys: string[]): string[] | undefined {
  return findWrapperPath(value, preferredKeys, true) ?? undefined
}

export function findExplicitWrapperPath(value: unknown, preferredKeys: string[]): string[] | undefined {
  return findWrapperPath(value, preferredKeys, false) ?? undefined
}

function collectSpuriousXmlTags(content: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!/^\s*<\/?[a-zA-Z_][a-zA-Z0-9_-]*\s*\/?\s*>\s*$/.test(trimmed)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    tags.push(trimmed)
  }

  return tags
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isExactTaggedEnvelope(rawContent: string, tag: string, candidate: string): boolean {
  const trimmed = rawContent.trim()
  const escapedTag = escapeRegExp(tag)
  const match = trimmed.match(new RegExp(`^<${escapedTag}>\\s*([\\s\\S]*?)\\s*<\\/${escapedTag}>$`))
  if (!match) return false

  return (match[1] ?? '').trim() === candidate.trim()
}

export function shouldRecordStructuredCandidateRecovery(
  rawContent: string,
  candidate: string,
  options?: {
    tag?: string
  },
): boolean {
  if (candidate === rawContent.trim()) {
    return false
  }

  if (options?.tag && isExactTaggedEnvelope(rawContent, options.tag, candidate)) {
    return false
  }

  return true
}

export function appendWrapperKeyRepairWarning(repairWarnings: string[], wrapperPath?: string[]) {
  appendRepairWarningOnce(repairWarnings, buildWrapperKeyRepairWarning(wrapperPath))
}

function isControlNoiseChar(code: number) {
  return (code >= 0 && code <= 8)
    || code === 11
    || code === 12
    || (code >= 14 && code <= 31)
    || code === 127
}

function readAnsiEscapeSequence(text: string, start: number): number | null {
  if (text.charCodeAt(start) !== 27 || text[start + 1] !== '[') return null
  let cursor = start + 2
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code >= 0x40 && code <= 0x7e) {
      return cursor + 1
    }
    if (!((code >= 0x20 && code <= 0x2f) || (code >= 0x30 && code <= 0x3f))) {
      return null
    }
    cursor += 1
  }
  return null
}

function readBracketedPasteSequence(text: string, start: number): number | null {
  if (text[start] !== '[') return null

  for (const token of ['200', '201']) {
    const prefix = `[${token}~`
    if (text.startsWith(prefix, start)) {
      const end = start + prefix.length
      return text[end] === '[' ? end + 1 : end
    }
  }

  const marker = text[start + 1]
  if (!marker || !/[A-Za-z]/.test(marker)) return null
  if (text[start + 2] !== '~') return null

  const end = start + 3
  return text[end] === '[' ? end + 1 : end
}

function isTerminalNoiseText(text: string): boolean {
  if (!text) return false

  let cursor = 0
  while (cursor < text.length) {
    const escapeEnd = readAnsiEscapeSequence(text, cursor)
    if (escapeEnd !== null) {
      cursor = escapeEnd
      continue
    }

    const bracketEnd = readBracketedPasteSequence(text, cursor)
    if (bracketEnd !== null) {
      cursor = bracketEnd
      continue
    }

    if (isControlNoiseChar(text.charCodeAt(cursor))) {
      cursor += 1
      continue
    }

    if (!/\s/.test(text[cursor] ?? '')) {
      return false
    }
    cursor += 1
  }

  return true
}

function findBalancedJsonRootEnd(content: string): number | null {
  let index = 0
  while (index < content.length && /\s/.test(content[index] ?? '')) {
    index += 1
  }

  if (index >= content.length) return null

  const start = content[index]!
  if (start === '{' || start === '[') {
    let depth = 0
    let inString = false
    let escaped = false

    for (let cursor = index; cursor < content.length; cursor += 1) {
      const char = content[cursor]!
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (char === '\\') {
          escaped = true
          continue
        }
        if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{' || char === '[') {
        depth += 1
        continue
      }
      if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) {
          return cursor + 1
        }
      }
    }
    return null
  }

  if (start === '"') {
    let escaped = false
    for (let cursor = index + 1; cursor < content.length; cursor += 1) {
      const char = content[cursor]!
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        return cursor + 1
      }
    }
    return null
  }

  const primitiveMatch = content.slice(index).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
  if (!primitiveMatch?.[0]) return null
  return index + primitiveMatch[0].length
}

function stripTrailingTerminalNoiseFromBalancedJson(content: string): string | null {
  const rootEnd = findBalancedJsonRootEnd(content)
  if (rootEnd === null || rootEnd >= content.length) return null

  const remainder = content.slice(rootEnd)
  if (!isTerminalNoiseText(remainder)) return null

  return content.slice(0, rootEnd).trimEnd()
}

function stripTrailingTerminalNoiseLines(content: string): string | null {
  const lines = content.split('\n')
  let end = lines.length

  while (end > 0 && lines[end - 1]?.trim() === '') {
    end -= 1
  }

  let cursor = end
  while (cursor > 0) {
    const trimmed = lines[cursor - 1]?.trim() ?? ''
    if (!trimmed || !isTerminalNoiseText(trimmed)) {
      break
    }
    cursor -= 1
  }

  if (cursor === end) return null

  const stripped = lines.slice(0, cursor).join('\n').trimEnd()
  return stripped || null
}

function stripTrailingInlineTerminalNoise(content: string): string | null {
  for (let start = content.length - 1; start >= 0; start -= 1) {
    const code = content.charCodeAt(start)
    if (!isControlNoiseChar(code) && code !== 27 && content[start] !== '[') continue

    const suffix = content.slice(start)
    if (!isTerminalNoiseText(suffix)) continue

    const stripped = content.slice(0, start).trimEnd()
    if (!stripped) continue

    const lastChar = stripped[stripped.length - 1]
    if (!lastChar || !/["'}\]\w.-]/.test(lastChar)) continue

    return stripped
  }

  return null
}

function buildTrailingTerminalNoiseVariants(content: string): string[] {
  const variants: string[] = []
  const seen = new Set<string>()

  const addVariant = (value: string | null) => {
    const normalized = value?.trim()
    if (!normalized || normalized === content || seen.has(normalized)) return
    seen.add(normalized)
    variants.push(normalized)
  }

  addVariant(stripTrailingTerminalNoiseFromBalancedJson(content))
  addVariant(stripTrailingInlineTerminalNoise(content))
  addVariant(stripTrailingTerminalNoiseLines(content))

  return variants
}

function stripTrailingClosingCodeFenceLine(content: string): string | null {
  const lines = content.split('\n')
  let end = lines.length

  while (end > 0 && lines[end - 1]?.trim() === '') {
    end -= 1
  }

  if (end === 0) return null

  const lastLine = lines[end - 1]?.trim() ?? ''
  if (!/^```$/.test(lastLine)) return null

  for (let index = 0; index < end - 1; index += 1) {
    if (/^```(?:yaml|yml|jsonl|json)?\s*$/i.test(lines[index]?.trim() ?? '')) {
      return null
    }
  }

  const stripped = lines.slice(0, end - 1).join('\n').trimEnd()
  return stripped || null
}

export function parseYamlOrJsonCandidate(
  content: string,
  options?: ParseYamlOrJsonCandidateOptions,
): unknown {
  const applyNestedMappingRepair = (value: string): string => options?.nestedMappingChildren
    ? repairYamlNestedMappingChildren(value, options.nestedMappingChildren)
    : value
  const trimmed = content.trim()
  if (!trimmed) return null

  const tryParseCandidate = (candidate: string, allowTrailingNoiseVariants = true): unknown => {
    const finalizeParsedCandidate = (
      parsed: unknown,
      appliedRepairs?: {
        markdownCodeFence?: boolean
        nestedMappingChildren?: boolean
        inlineYaml?: boolean
        mappingKeyColonSpace?: boolean
        wrappedPlainListScalar?: boolean
        plainScalarColon?: boolean
        sequenceItemPrimaryKey?: YamlSequenceItemPrimaryKeyRepair[]
        freeTextScalar?: boolean
        listDashSpace?: boolean
        duplicateKeys?: boolean
        xmlStyleTags?: string[]
      },
    ): unknown => {
      if (appliedRepairs?.markdownCodeFence) {
        appendRepairWarningOnce(options?.repairWarnings, MARKDOWN_CODE_FENCE_WARNING)
      }
      if (appliedRepairs?.nestedMappingChildren) {
        appendRepairWarningOnce(options?.repairWarnings, NESTED_MAPPING_CHILDREN_WARNING)
      }
      if (appliedRepairs?.inlineYaml) {
        appendRepairWarningOnce(options?.repairWarnings, INLINE_YAML_WARNING)
      }
      if (appliedRepairs?.mappingKeyColonSpace) {
        appendRepairWarningOnce(options?.repairWarnings, MAPPING_KEY_COLON_SPACE_WARNING)
      }
      if (appliedRepairs?.wrappedPlainListScalar) {
        appendRepairWarningOnce(options?.repairWarnings, WRAPPED_PLAIN_LIST_SCALAR_WARNING)
      }
      if (appliedRepairs?.plainScalarColon) {
        appendRepairWarningOnce(options?.repairWarnings, PLAIN_SCALAR_COLON_WARNING)
      }
      for (const repair of appliedRepairs?.sequenceItemPrimaryKey ?? []) {
        appendRepairWarningOnce(options?.repairWarnings, buildSequenceItemPrimaryKeyRepairWarning(repair))
      }
      if (appliedRepairs?.freeTextScalar) {
        appendRepairWarningOnce(options?.repairWarnings, FREE_TEXT_SCALAR_WARNING)
      }
      if (appliedRepairs?.listDashSpace) {
        appendRepairWarningOnce(options?.repairWarnings, LIST_DASH_SPACE_WARNING)
      }
      if (appliedRepairs?.duplicateKeys) {
        appendRepairWarningOnce(options?.repairWarnings, DUPLICATE_KEYS_WARNING)
      }
      if (appliedRepairs?.xmlStyleTags && appliedRepairs.xmlStyleTags.length > 0) {
        appendRepairWarningOnce(options?.repairWarnings, buildXmlStyleTagsWarning(appliedRepairs.xmlStyleTags))
      }
      return parsed
    }

    try {
      return JSON.parse(candidate)
    } catch {
      if (allowTrailingNoiseVariants && options?.allowTrailingTerminalNoise) {
        for (const variant of buildTrailingTerminalNoiseVariants(candidate)) {
          try {
            const parsed = tryParseCandidate(variant, false)
            appendRepairWarningOnce(options.repairWarnings, TERMINAL_NOISE_WARNING)
            return parsed
          } catch { /* try the next stripped-noise variant */ }
        }
      }

      const repairedTrimmed = applyNestedMappingRepair(candidate)
      if (repairedTrimmed !== candidate) {
        try {
          return finalizeParsedCandidate(jsYaml.load(repairedTrimmed), {
            nestedMappingChildren: true,
          })
        } catch { /* fall through to the original input and later repairs */ }
      }

      const inlineSequencePreRepaired = repairYamlInlineSequenceParents(candidate)
      const inlineKeyPreRepaired = repairYamlInlineKeys(inlineSequencePreRepaired, {
        nestedMappingChildren: options?.nestedMappingChildren,
      })
      const mappingKeyColonSpacePreRepaired = repairYamlMappingKeyColonSpace(inlineKeyPreRepaired, {
        sequenceItemPrimaryKeys: options?.sequenceItemPrimaryKeys,
      })
      const wrappedPlainListScalarPreRepaired = repairYamlWrappedPlainListScalars(mappingKeyColonSpacePreRepaired)
      const plainScalarColonPreRepaired = repairYamlPlainScalarColons(wrappedPlainListScalarPreRepaired)
      const sequenceItemPrimaryKeyPreRepaired = repairYamlSequenceItemPrimaryKeys(
        plainScalarColonPreRepaired,
        options?.sequenceItemPrimaryKeys,
      )
      const preParseRepaired = applyNestedMappingRepair(sequenceItemPrimaryKeyPreRepaired.yaml)
      if (preParseRepaired !== candidate) {
        try {
          return finalizeParsedCandidate(jsYaml.load(preParseRepaired), {
            inlineYaml: inlineSequencePreRepaired !== candidate || inlineKeyPreRepaired !== inlineSequencePreRepaired,
            mappingKeyColonSpace: mappingKeyColonSpacePreRepaired !== inlineKeyPreRepaired,
            wrappedPlainListScalar: wrappedPlainListScalarPreRepaired !== mappingKeyColonSpacePreRepaired,
            plainScalarColon: plainScalarColonPreRepaired !== wrappedPlainListScalarPreRepaired,
            sequenceItemPrimaryKey: sequenceItemPrimaryKeyPreRepaired.repairs,
            nestedMappingChildren: preParseRepaired !== sequenceItemPrimaryKeyPreRepaired.yaml,
          })
        } catch { /* fall through to the original input and later repairs */ }
      }

      try {
        return jsYaml.load(candidate)
      } catch {
        // First repair: strip markdown code fences if present
        const defenced = stripCodeFences(candidate)
        const effectiveBase = defenced !== candidate ? defenced.trim() : candidate

        if (effectiveBase !== candidate) {
          try {
            return finalizeParsedCandidate(
              tryParseCandidate(effectiveBase, allowTrailingNoiseVariants),
              { markdownCodeFence: true },
            )
          } catch { /* fall through to further repairs */ }
        }

        // Earliest repair: split inline sequence parents and keys onto separate lines (prerequisite for all other repairs)
        const inlineSequenceRepaired = repairYamlInlineSequenceParents(effectiveBase)
        const inlineRepaired = repairYamlInlineKeys(inlineSequenceRepaired, {
          nestedMappingChildren: options?.nestedMappingChildren,
        })
        const mappingKeyColonSpaceRepaired = repairYamlMappingKeyColonSpace(inlineRepaired, {
          sequenceItemPrimaryKeys: options?.sequenceItemPrimaryKeys,
        })
        const sequenceItemPrimaryKeyInlineRepaired = repairYamlSequenceItemPrimaryKeys(
          mappingKeyColonSpaceRepaired,
          options?.sequenceItemPrimaryKeys,
        )
        if (sequenceItemPrimaryKeyInlineRepaired.yaml !== effectiveBase) {
          const nestedInlineRepaired = applyNestedMappingRepair(sequenceItemPrimaryKeyInlineRepaired.yaml)
          if (nestedInlineRepaired !== sequenceItemPrimaryKeyInlineRepaired.yaml) {
            try {
              return finalizeParsedCandidate(jsYaml.load(nestedInlineRepaired), {
                nestedMappingChildren: true,
                inlineYaml: inlineRepaired !== effectiveBase,
                mappingKeyColonSpace: mappingKeyColonSpaceRepaired !== inlineRepaired,
                sequenceItemPrimaryKey: sequenceItemPrimaryKeyInlineRepaired.repairs,
              })
            } catch { /* fall through — later repairs may still be needed */ }
          }
          try {
            return finalizeParsedCandidate(jsYaml.load(sequenceItemPrimaryKeyInlineRepaired.yaml), {
              inlineYaml: inlineRepaired !== effectiveBase,
              mappingKeyColonSpace: mappingKeyColonSpaceRepaired !== inlineRepaired,
              sequenceItemPrimaryKey: sequenceItemPrimaryKeyInlineRepaired.repairs,
            })
          } catch { /* fall through — lines split but further repairs may be needed */ }
        }
        const afterInline = sequenceItemPrimaryKeyInlineRepaired.yaml !== effectiveBase
          ? sequenceItemPrimaryKeyInlineRepaired.yaml
          : effectiveBase

        // Pre-processing: strip XML tags, quote fragile free_text values, remove duplicate keys, fix missing list-dash space
        const xmlStripped = stripSpuriousXmlTags(afterInline)
        const xmlTags = xmlStripped !== afterInline ? collectSpuriousXmlTags(afterInline) : []
        const wrappedPlainListScalarRepaired = repairYamlWrappedPlainListScalars(xmlStripped)
        const freeTextQuoted = repairYamlFreeTextScalars(wrappedPlainListScalarRepaired)
        const dashFixed = repairYamlListDashSpace(freeTextQuoted)
        const deduped = repairYamlDuplicateKeys(dashFixed)
        const base = applyNestedMappingRepair(deduped)
        const appliedPreParseRepairs = {
          sequenceItemPrimaryKey: sequenceItemPrimaryKeyInlineRepaired.repairs,
          wrappedPlainListScalar: wrappedPlainListScalarRepaired !== xmlStripped,
          freeTextScalar: freeTextQuoted !== wrappedPlainListScalarRepaired,
          // These two were applied but never recorded, so a payload rescued by
          // them reported no repair at all.
          listDashSpace: dashFixed !== freeTextQuoted,
          duplicateKeys: deduped !== dashFixed,
          xmlStyleTags: xmlTags,
        }

        // Pre-processing alone might fix it (e.g. duplicate keys or missing dash space were the only issue)
        if (base !== afterInline) {
          try {
            return finalizeParsedCandidate(jsYaml.load(base), appliedPreParseRepairs)
          } catch { /* fall through to targeted repairs */ }
        }

        const doubleQuotedEscapeRepaired = repairYamlDoubleQuotedInvalidEscapes(base)
        const doubleQuotedEscapeBase = doubleQuotedEscapeRepaired !== base ? doubleQuotedEscapeRepaired : base
        const appendDoubleQuotedEscapeRepairWarning = () => {
          if (doubleQuotedEscapeRepaired !== base) {
            appendRepairWarningOnce(options?.repairWarnings, DOUBLE_QUOTED_ESCAPE_WARNING)
          }
        }

        if (doubleQuotedEscapeRepaired !== base) {
          try {
            const parsed = jsYaml.load(doubleQuotedEscapeRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            try {
              const parsed = jsYaml.load(repairYamlIndentation(doubleQuotedEscapeRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through to later repairs */ }
          }
        }

        const doubleQuotedInnerQuoteRepaired = repairYamlDoubleQuotedScalarInnerQuotes(doubleQuotedEscapeBase)
        const doubleQuotedScalarBase = doubleQuotedInnerQuoteRepaired !== doubleQuotedEscapeBase
          ? doubleQuotedInnerQuoteRepaired
          : doubleQuotedEscapeBase
        const appendDoubleQuotedInnerQuoteRepairWarning = () => {
          if (doubleQuotedInnerQuoteRepaired !== doubleQuotedEscapeBase) {
            appendRepairWarningOnce(options?.repairWarnings, QUOTED_SCALAR_WARNING)
          }
        }

        if (doubleQuotedInnerQuoteRepaired !== doubleQuotedEscapeBase) {
          try {
            const parsed = jsYaml.load(doubleQuotedInnerQuoteRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            try {
              const parsed = jsYaml.load(repairYamlIndentation(doubleQuotedInnerQuoteRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through to later repairs */ }
          }
        }

        // Try unclosed-quote repair
        const quoteRepaired = repairYamlUnclosedQuotes(doubleQuotedScalarBase)
        const appendUnbalancedQuoteRepairWarning = () => {
          if (quoteRepaired !== doubleQuotedScalarBase) {
            appendRepairWarningOnce(options?.repairWarnings, UNBALANCED_QUOTE_WARNING)
          }
        }
        if (quoteRepaired !== doubleQuotedScalarBase) {
          try {
            const parsed = jsYaml.load(quoteRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendUnbalancedQuoteRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            // Try combined: unclosed-quote + indentation repair
            try {
              const parsed = jsYaml.load(repairYamlIndentation(quoteRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendUnbalancedQuoteRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        const quotedScalarRepaired = repairYamlQuotedScalarFragments(doubleQuotedScalarBase)
        if (quotedScalarRepaired !== doubleQuotedScalarBase) {
          try {
            const parsed = jsYaml.load(quotedScalarRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendRepairWarningOnce(options?.repairWarnings, QUOTED_SCALAR_WARNING)
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            try {
              const parsed = jsYaml.load(repairYamlIndentation(quotedScalarRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendRepairWarningOnce(options?.repairWarnings, QUOTED_SCALAR_WARNING)
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        const postQuotedScalarBase = quotedScalarRepaired !== doubleQuotedScalarBase ? quotedScalarRepaired : doubleQuotedScalarBase
        const appendQuotedScalarRepairWarning = () => {
          if (postQuotedScalarBase !== doubleQuotedScalarBase) {
            appendRepairWarningOnce(options?.repairWarnings, QUOTED_SCALAR_WARNING)
          }
        }

        const unionRepaired = repairYamlTypeUnionScalars(postQuotedScalarBase)
        if (unionRepaired !== postQuotedScalarBase) {
          try {
            const parsed = jsYaml.load(unionRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendQuotedScalarRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            try {
              const parsed = jsYaml.load(repairYamlIndentation(unionRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendQuotedScalarRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        // Try colon-in-scalar repair (most targeted fix)
        const colonRepaired = repairYamlPlainScalarColons(postQuotedScalarBase)
        const appendPlainScalarColonRepairWarning = () => {
          if (colonRepaired !== postQuotedScalarBase) {
            appendRepairWarningOnce(options?.repairWarnings, PLAIN_SCALAR_COLON_WARNING)
          }
        }
        if (colonRepaired !== postQuotedScalarBase) {
          try {
            const parsed = jsYaml.load(colonRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendQuotedScalarRepairWarning()
            appendPlainScalarColonRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            // Try combined: colon repair + indentation repair
            try {
              const parsed = jsYaml.load(repairYamlIndentation(colonRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendQuotedScalarRepairWarning()
              appendPlainScalarColonRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        const reservedIndicatorBase = colonRepaired !== postQuotedScalarBase ? colonRepaired : postQuotedScalarBase
        const reservedIndicatorRepaired = repairYamlReservedIndicatorScalars(reservedIndicatorBase)
        if (reservedIndicatorRepaired !== reservedIndicatorBase) {
          try {
            const parsed = jsYaml.load(reservedIndicatorRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendQuotedScalarRepairWarning()
            appendPlainScalarColonRepairWarning()
            appendRepairWarningOnce(options?.repairWarnings, RESERVED_INDICATOR_SCALAR_WARNING)
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            try {
              const parsed = jsYaml.load(repairYamlIndentation(reservedIndicatorRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendQuotedScalarRepairWarning()
              appendPlainScalarColonRepairWarning()
              appendRepairWarningOnce(options?.repairWarnings, RESERVED_INDICATOR_SCALAR_WARNING)
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        // Try sequence-entry indent repair (fixes dashes drifted after block scalars)
        const seqRepaired = repairYamlSequenceEntryIndent(postQuotedScalarBase)
        if (seqRepaired !== postQuotedScalarBase) {
          try {
            const parsed = jsYaml.load(seqRepaired)
            appendDoubleQuotedEscapeRepairWarning()
            appendDoubleQuotedInnerQuoteRepairWarning()
            appendQuotedScalarRepairWarning()
            return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
          } catch {
            // Try combined: sequence entry + property indentation repair
            try {
              const parsed = jsYaml.load(repairYamlIndentation(seqRepaired))
              appendDoubleQuotedEscapeRepairWarning()
              appendDoubleQuotedInnerQuoteRepairWarning()
              appendQuotedScalarRepairWarning()
              return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
            } catch { /* fall through */ }
          }
        }

        const finalQuoteRepaired = repairYamlUnclosedQuotes(postQuotedScalarBase)
        const repaired = repairYamlIndentation(finalQuoteRepaired)
        const parsed = jsYaml.load(repaired)
        appendDoubleQuotedEscapeRepairWarning()
        appendDoubleQuotedInnerQuoteRepairWarning()
        appendQuotedScalarRepairWarning()
        if (finalQuoteRepaired !== postQuotedScalarBase) {
          appendRepairWarningOnce(options?.repairWarnings, UNBALANCED_QUOTE_WARNING)
        }
        return finalizeParsedCandidate(parsed, appliedPreParseRepairs)
      }
    }
  }

  const orphanClosingFenceStripped = stripTrailingClosingCodeFenceLine(trimmed)
  const variants = orphanClosingFenceStripped ? [trimmed, orphanClosingFenceStripped] : [trimmed]
  let lastError: unknown = null

  for (let index = 0; index < variants.length; index += 1) {
    try {
      const parsed = tryParseCandidate(variants[index]!)
      if (index > 0) {
        appendRepairWarningOnce(options?.repairWarnings, ORPHAN_CLOSING_CODE_FENCE_WARNING)
      }
      return parsed
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to parse structured artifact candidate')
}

export function appendStructuredCandidateRecoveryWarning(
  repairWarnings: string[],
  rawContent: string,
  candidate: string,
  options?: {
    tag?: string
  },
) {
  if (shouldRecordStructuredCandidateRecovery(rawContent, candidate, options) && !repairWarnings.includes(CANDIDATE_RECOVERY_WARNING)) {
    repairWarnings.push(CANDIDATE_RECOVERY_WARNING)
  }
}

function quoteYamlDoubleQuotedScalar(value: string): string {
  return JSON.stringify(value)
}

export function repairCoverageGapStringList(content: string): {
  content: string
  repairApplied: boolean
  repairWarnings: string[]
} {
  const lines = content.split('\n')
  const repairedLines: string[] = []
  const topLevelKeyPattern = /^[A-Za-z_][A-Za-z0-9_-]*\s*:/
  let activeGapIndent = -1
  let directItemIndent = -1
  let repairApplied = false

  for (const line of lines) {
    const trimmed = line.trim()
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0

    if (activeGapIndent >= 0) {
      if (trimmed && !trimmed.startsWith('#') && indent <= activeGapIndent && topLevelKeyPattern.test(trimmed)) {
        activeGapIndent = -1
        directItemIndent = -1
      } else {
        if (indent === directItemIndent && /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/.test(trimmed)) {
          const repairedLine = `${' '.repeat(directItemIndent)}- ${trimmed}`
          repairedLines.push(repairedLine)
          repairApplied = repairApplied || repairedLine !== line
          continue
        }

        if (indent === directItemIndent && trimmed.startsWith('- ')) {
          const itemValue = trimmed.slice(2).trim()
          if (itemValue && !/^(["']|[>|])/.test(itemValue)) {
            const repairedLine = `${' '.repeat(directItemIndent)}- ${quoteYamlDoubleQuotedScalar(itemValue)}`
            repairedLines.push(repairedLine)
            repairApplied = repairApplied || repairedLine !== line
            continue
          }
        }

        repairedLines.push(line)
        continue
      }
    }

    const gapBlockMatch = line.match(/^(\s*)(gaps|issues)\s*:\s*$/)
    if (gapBlockMatch) {
      activeGapIndent = gapBlockMatch[1]?.length ?? 0
      directItemIndent = activeGapIndent + 2
    }

    repairedLines.push(line)
  }

  return {
    content: repairedLines.join('\n'),
    repairApplied,
    repairWarnings: repairApplied
      ? ['Repaired malformed coverage gap list items before reparsing.']
      : [],
  }
}

export function maybeUnwrapRecord(
  value: unknown,
  preferredKeys: string[],
  depth: number = 0,
): unknown {
  if (!isRecord(value) || depth > 4) return value

  for (const [key, nested] of Object.entries(value)) {
    if (!preferredKeys.includes(normalizeKey(key))) continue
    return maybeUnwrapRecord(nested, preferredKeys, depth + 1)
  }

  const keys = Object.keys(value)
  if (keys.length === 1) {
    return maybeUnwrapRecord(value[keys[0]!], preferredKeys, depth + 1)
  }

  return value
}

export function unwrapExplicitWrapperRecord(
  value: unknown,
  preferredKeys: string[],
  depth: number = 0,
): unknown {
  if (!isRecord(value) || depth > 4) return value

  for (const [key, nested] of Object.entries(value)) {
    if (!preferredKeys.includes(normalizeKey(key))) continue
    return unwrapExplicitWrapperRecord(nested, preferredKeys, depth + 1)
  }

  return value
}

export function toStringArray(value: unknown): string[] {
  const normalizeEntry = (entry: unknown): string => {
    if (entry instanceof Date) return entry.toISOString()
    if (typeof entry === 'string') return entry.trim()
    if (entry === null || entry === undefined) return ''
    if (typeof entry === 'object') {
      return (jsYaml.dump(entry, { lineWidth: 120, noRefs: true }) as string).trim()
    }
    return String(entry).trim()
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeEntry(entry))
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.includes('\n')) {
      return trimmed
        .split('\n')
        .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
        .filter(Boolean)
    }
    return [trimmed]
  }
  return []
}

export function toOptionalString(value: unknown): string | undefined {
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : undefined
  if (typeof normalized !== 'string') return undefined
  const trimmed = normalized.trim()
  return trimmed || undefined
}

export function toInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

export function toOrdinalInteger(value: unknown): number | null {
  const direct = toInteger(value)
  if (direct != null) return direct

  const normalized = toOptionalString(value)
  if (!normalized) return null

  const labeledMatch = normalized.match(/(?:^|[^a-z0-9])(?:alternative\s*draft|draft)(?:\s*#?\s*|[^0-9]+)(\d+)(?:$|[^a-z0-9])/i)
  if (labeledMatch?.[1]) {
    const parsed = Number(labeledMatch[1])
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }

  const fallbackMatch = normalized.match(/\b(\d+)\b/)
  if (!fallbackMatch?.[1]) return null
  const parsed = Number(fallbackMatch[1])
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

export function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true
  if (['false', 'no', 'n', '0'].includes(normalized)) return false
  return null
}

/**
 * Where alias-conflict warnings go while a candidate is being parsed.
 *
 * `getValueByAliases` has close to three hundred call sites, nearly none of which
 * hold a warnings array, so the sink is installed once per candidate by
 * `withAliasConflictWarnings` and every nested lookup inherits it. Parsing is
 * synchronous, so the value is only ever set for the duration of one call.
 */
let activeAliasConflictWarnings: string[] | null = null

/**
 * Routes alias conflicts found from here on into `repairWarnings`, until the
 * returned release function runs. Call it from a `finally`: the sinks nest, so a
 * normaliser invoked from inside another gets its own and hands the outer one
 * back on the way out.
 */
export function collectAliasConflictWarnings(repairWarnings: string[]): () => void {
  const previous = activeAliasConflictWarnings
  activeAliasConflictWarnings = repairWarnings
  let released = false
  return () => {
    if (released) return
    released = true
    activeAliasConflictWarnings = previous
  }
}

/** `collectAliasConflictWarnings` for a block that can be expressed as a callback. */
export function withAliasConflictWarnings<T>(repairWarnings: string[], run: () => T): T {
  const release = collectAliasConflictWarnings(repairWarnings)
  try {
    return run()
  } finally {
    release()
  }
}

function isSameAliasValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => isSameAliasValue(entry, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && isSameAliasValue(left[key], right[key]))
  }
  return false
}

/**
 * Resolves a field by alias, canonical name first.
 *
 * This used to iterate the record's own insertion order and return the first
 * match, so a payload carrying both the canonical name and a legacy alias with
 * different values resolved by whichever the model happened to write first. The
 * alias list is the precedence order now, and a disagreement is reported.
 */
export function getValueByAliases(record: Record<string, unknown>, aliases: string[]): unknown {
  const matchesByAlias = new Map<string, Array<{ key: string; value: unknown }>>()
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalizeKey(key)
    const existing = matchesByAlias.get(normalizedKey)
    if (existing) existing.push({ key, value })
    else matchesByAlias.set(normalizedKey, [{ key, value }])
  }

  let resolved: { key: string; value: unknown } | undefined
  const conflicting: string[] = []

  for (const alias of aliases) {
    for (const match of matchesByAlias.get(normalizeKey(alias)) ?? []) {
      if (!resolved) {
        resolved = match
        continue
      }
      if (!isSameAliasValue(resolved.value, match.value)) {
        conflicting.push(match.key)
      }
    }
  }

  if (resolved && conflicting.length > 0) {
    activeAliasConflictWarnings?.push(
      `Resolved "${resolved.key}" and ignored the conflicting ${conflicting.length === 1 ? 'value' : 'values'} in ${conflicting.map((key) => `"${key}"`).join(', ')}.`,
    )
  }

  return resolved?.value
}

export function getNestedRecord(record: Record<string, unknown>, aliases: string[]): Record<string, unknown> {
  const value = getValueByAliases(record, aliases)
  return isRecord(value) ? value : {}
}

export function getRequiredString(record: Record<string, unknown>, aliases: string[], label: string): string {
  const value = getValueByAliases(record, aliases)
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null
  if (!normalized || !normalized.trim()) {
    throw new Error(`Missing required ${label}`)
  }
  return normalized.trim()
}

export function buildYamlDocument(value: unknown): string {
  return jsYaml.dump(value, { lineWidth: 120, noRefs: true }) as string
}

export function buildJsonlDocument(records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

export function buildStructuredRetryPrompt(
  baseParts: PromptPart[],
  options: {
    validationError: string
    rawResponse: string
    schemaReminder?: string
  },
): PromptPart[] {
  return [
    ...baseParts,
    {
      type: 'text',
      content: [
        '## Structured Output Retry',
        `Your previous response failed machine validation: ${options.validationError}`,
        'Return only a corrected artifact in the required structured format.',
        options.schemaReminder ? `Schema reminder:\n${options.schemaReminder}` : '',
        'Previous invalid response:',
        '```',
        options.rawResponse.trim() || '[empty response]',
        '```',
      ].filter(Boolean).join('\n\n'),
    },
  ]
}
