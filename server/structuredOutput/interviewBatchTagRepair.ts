import * as jsYaml from 'js-yaml'
import { isRecord, normalizeKey } from './yamlUtils'

const BATCH_FIELDS = new Set(['batchnumber', 'progress', 'isfinalfreeform', 'aicommentary', 'questions'])

/** Recover only schema fields; XML inside emitted prose or YAML values is payload. */
export function repairInterviewBatchFieldTags(content: string): {
  content: string
  repairWarnings: string[]
} | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  const repairWarnings: string[] = []
  const seen = new Set<string>()
  const warn = (path: string, index: number, before: string, after: string) => {
    repairWarnings.push(`Repaired interview batch field tag at ${path}, payload line ${index + 1}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}.`)
  }
  const claim = (field: string) => {
    const key = normalizeKey(field)
    if (!BATCH_FIELDS.has(key) || seen.has(key)) throw new Error('Ambiguous interview field')
    seen.add(key)
  }

  try {
    for (let index = 0; index < lines.length;) {
      const line = lines[index]!
      if (!line.trim()) {
        output.push(line)
        index += 1
        continue
      }

      const inline = line.match(/^<(batch_number|is_final_free_form|ai_commentary)>(.*)<\/\1>\s*$/)
      if (inline) {
        const field = inline[1]!
        const value = inline[2]!
        claim(field)
        if (field === 'batch_number' && !/^\d+$/.test(value.trim())) return null
        if (field === 'is_final_free_form' && !/^(true|false)$/.test(value.trim())) return null
        const after = `${field}: ${field === 'ai_commentary' ? JSON.stringify(value) : value.trim()}`
        output.push(after)
        warn(field, index, line, after)
        index += 1
        continue
      }

      const opening = line.match(/^<(progress|ai_commentary|questions)>\s*$/)
      if (opening) {
        const field = opening[1]!
        claim(field)
        let end = lines.findIndex((candidate, position) => position > index && candidate.trimEnd() === `</${field}>`)
        // Remove the known terminal closer here so generic XML repair cannot strip question text.
        const strayQuestionsClose = field === 'questions' && end < 0
        if (strayQuestionsClose) {
          end = lines.findIndex((candidate, position) => position > index && candidate.trimEnd() === '</parameter>')
          if (end < 0 || lines.slice(end + 1).some((candidate) => candidate.trim())) return null
        }
        if (end < 0) return null
        const body = lines.slice(index + 1, end)
        if (field === 'ai_commentary') {
          const after = `ai_commentary: ${JSON.stringify(body.join('\n'))}`
          output.push(after)
          warn(field, index, lines.slice(index, end + 1).join('\n'), after)
        } else {
          output.push(`${field}:`)
          warn(field, index, line, `${field}:`)
          for (const [offset, child] of body.entries()) {
            const taggedChild = field === 'progress' ? child.match(/^(\s*)<(current|total)>(\d+)<\/\2>\s*$/) : null
            if (taggedChild) {
              const after = `  ${taggedChild[2]}: ${taggedChild[3]}`
              output.push(after)
              warn(`progress.${taggedChild[2]}`, index + offset + 1, child, after)
            } else {
              output.push(child)
            }
          }
          warn(field, end, lines[end]!, '')
        }
        index = end + 1
        continue
      }

      // Strictly parse native YAML spans so a tag in a quoted or literal value
      // cannot be mistaken for a field, and duplicate keys cannot be discarded.
      let end = index + 1
      while (end < lines.length && !/^</.test(lines[end]!)) end += 1
      const native = jsYaml.load(lines.slice(index, end).join('\n'))
      if (!isRecord(native)) return null
      for (const field of Object.keys(native)) claim(field)
      output.push(...lines.slice(index, end))
      index = end
    }

    if (repairWarnings.length === 0) return null
    const repaired = output.join('\n')
    const parsed = jsYaml.load(repaired)
    if (!isRecord(parsed)) return null
    const fields = new Map(Object.entries(parsed).map(([key, value]) => [normalizeKey(key), value]))
    const progress = fields.get('progress')
    const questions = fields.get('questions')
    if (fields.size !== BATCH_FIELDS.size || fields.size !== Object.keys(parsed).length
      || !Number.isSafeInteger(fields.get('batchnumber'))
      || !isRecord(progress)
      || Object.keys(progress).length !== 2
      || !Number.isSafeInteger(progress.current)
      || !Number.isSafeInteger(progress.total)
      || !Array.isArray(questions) || questions.length === 0 || !questions.every(isRecord)
      || typeof fields.get('isfinalfreeform') !== 'boolean'
      || typeof fields.get('aicommentary') !== 'string') return null
    return { content: repaired, repairWarnings }
  } catch {
    return null
  }
}
