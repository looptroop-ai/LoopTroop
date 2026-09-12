import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { normalizeBeadRefinementOutput } from '../server/structuredOutput/beadsOutput'
import { parseYamlOrJsonCandidate } from '../server/structuredOutput/yamlUtils'

// Representative inputs from yamlUtils.test.ts and repairWarningBookkeeping.test.ts.
const fixtures = [
  ['json', '{"status":"clean","gaps":[],"follow_up_questions":[]}'],
  ['yaml', 'status: clean\ngaps: []\nfollow_up_questions: []'],
  ['inline mapping', 'questions: - id: Q01 phase: foundation question: What behavior should the API expose?'],
  ['scalar colons', 'api_contracts:\n  - Content-Disposition: attachment; filename=synonyms.json'],
  ['list dash', 'items:\n  -id: one\n  -id: two'],
  ['duplicate keys', 'options:\n  - first\noptions:\n  - second'],
  ['unclosed quote', 'type: string | null\nname: "x'],
  ['invalid output', 'a: "unclosed\nb: [1, 2'],
] as const

// One bead from phases/beads/__tests__/refined.test.ts, parsed as refined + winner drafts.
const beadDraft = [
  'beads:',
  '  - id: bead-1',
  '    title: Keep existing switcher bead',
  '    prdRefs: [EPIC-1, US-1]',
  '    description: Leave the switcher bead unchanged.',
  '    contextGuidance:',
  '      patterns: [Reuse the current theme switcher.]',
  '      anti_patterns: [Do not redesign the menu.]',
  '    acceptanceCriteria: [Keep the switcher bead unchanged.]',
  '    tests: [Test the unchanged switcher bead.]',
  '    testCommands: [npm test -- AppShell]',
].join('\n')

const samples = 5
const passes = 200
let nextMiss = 0

function inputFor(content: string, misses: boolean): string {
  if (!misses) return content
  const id = ++nextMiss
  // Each call misses without changing the YAML structure or JSON parsing path.
  return content.startsWith('{')
    ? content.replace('{', `{"_benchmark":${id},`)
    : `# benchmark ${id}\n${content}`
}

function parseCorpus(misses: boolean) {
  for (const [name, content] of fixtures) {
    const input = inputFor(content, misses)
    const options = { repairWarnings: [] as string[] }
    if (name === 'invalid output') {
      assert.throws(() => parseYamlOrJsonCandidate(input, options))
    } else {
      assert.ok(parseYamlOrJsonCandidate(input, options))
    }
  }
}

function refineBeads(misses: boolean) {
  const input = inputFor(beadDraft, misses)
  const result = normalizeBeadRefinementOutput(input, input)
  assert.ok(result.ok)
}

function measure(run: (misses: boolean) => void, misses: boolean): number {
  const durations: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    for (let pass = 0; pass < passes; pass++) run(misses)
    durations.push((performance.now() - start) / passes)
  }
  return durations.sort((a, b) => a - b)[Math.floor(samples / 2)]!
}

// Warm the runtime before collecting medians; no timing threshold gates correctness.
for (let pass = 0; pass < 20; pass++) {
  parseCorpus(true)
  refineBeads(true)
}
console.log(`Node ${process.version}; median of ${samples} samples, ${passes} passes per sample`)
console.log('Milliseconds per pass; corpus contains 8 candidates, refinement parses both drafts.')
for (const [label, run] of [['parse corpus', parseCorpus], ['bead refinement', refineBeads]] as const) {
  const missMs = measure(run, true)
  const repeatMs = measure(run, false)
  console.log(`${label}: unique=${missMs.toFixed(3)} ms, repeated=${repeatMs.toFixed(3)} ms`)
}
