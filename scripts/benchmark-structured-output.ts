import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { normalizeBeadRefinementOutput } from '../server/structuredOutput/beadsOutput'
import { buildYamlDocument, parseYamlOrJsonCandidate } from '../server/structuredOutput/yamlUtils'

// Representative inputs and expected values from the parser tests.
const fixtures = [
  ['json', '{"status":"clean","gaps":[],"follow_up_questions":[]}', { status: 'clean', gaps: [], follow_up_questions: [] }],
  ['yaml', 'status: clean\ngaps: []\nfollow_up_questions: []', { status: 'clean', gaps: [], follow_up_questions: [] }],
  ['inline mapping', 'questions: - id: Q01 phase: foundation question: What behavior should the API expose?', {
    questions: [{ id: 'Q01', phase: 'foundation', question: 'What behavior should the API expose?' }],
  }],
  ['scalar colons', 'api_contracts:\n  - Content-Disposition: attachment; filename=synonyms.json', {
    api_contracts: ['Content-Disposition: attachment; filename=synonyms.json'],
  }],
  ['list dash', 'items:\n  -id: one\n  -id: two', { items: [{ id: 'one' }, { id: 'two' }] }],
  ['duplicate keys', 'options:\n  - first\noptions:\n  - first', { options: ['first'] }],
  ['unclosed quote', 'type: string | null\nname: "x', { type: 'string | null', name: 'x' }],
] as const
const invalidOutput = 'a: "unclosed\nb: [1, 2'

// Scale the refinement-test bead shape into a realistic multi-bead artifact.
const beads = Array.from({ length: 64 }, (_, index) => ({
  id: `bead-${index + 1}`,
  title: `Preserve theme switcher behavior in view ${index + 1}`,
  prdRefs: [`EPIC-${Math.floor(index / 8) + 1}`, `US-${index + 1}`],
  description: 'Keep the selected theme when navigating between views and reopening the menu.',
  contextGuidance: {
    patterns: ['Reuse the existing theme provider and persist the selected preference.'],
    anti_patterns: ['Do not introduce another global store or redesign the menu.'],
  },
  acceptanceCriteria: ['The selected theme remains visible after the menu is reopened.'],
  tests: ['Select a theme, close the menu, reopen it, and check the selection.'],
  testCommands: [{ mode: 'process', program: 'npm', args: ['test', '--', 'AppShell'], cwd: '.', env: {} }],
}))
const beadDraft = buildYamlDocument({ beads: beads.slice(0, 1) })
const refinedDraft = buildYamlDocument({
  beads: [{ ...beads[0], description: 'Also retain the theme selection after refreshing the page.' }],
})
const largeDraft = buildYamlDocument({ beads })
const largeBytes = Buffer.byteLength(largeDraft)
assert.ok(largeBytes >= 35_000 && largeBytes <= 50_000)

const samples = 5
let nextMiss = 0

/** Add an equal-width marker; unique mode never reuses a previous marker. */
function inputFor(content: string, misses: boolean): string {
  const id = String(misses ? ++nextMiss : 0).padStart(8, '0')
  // Both modes do the same construction and parse equal-length inputs.
  return content.startsWith('{')
    ? `{"_benchmark":"${id}",${content.slice(1)}`
    : `# benchmark ${id}\n${content}`
}

/** Check each valid repair fixture against its expected parsed value. */
function parseCorpus(misses: boolean) {
  for (const [name, content, expected] of fixtures) {
    const { _benchmark, ...value } = parseYamlOrJsonCandidate(inputFor(content, misses), {
      repairWarnings: [],
    }) as Record<string, unknown>
    assert.equal(typeof _benchmark, name === 'json' ? 'string' : 'undefined')
    assert.deepEqual(value, expected, name)
  }
}

/** Measure rejected candidates separately because parse errors are not cached. */
function parseInvalid(misses: boolean) {
  assert.throws(() => parseYamlOrJsonCandidate(inputFor(invalidOutput, misses), { repairWarnings: [] }))
}

/** Verify the full multi-bead value while measuring artifact-sized parsing. */
function parseLarge(misses: boolean) {
  assert.deepEqual(parseYamlOrJsonCandidate(inputFor(largeDraft, misses), { repairWarnings: [] }), { beads })
}

/** Check normalization and change detection for distinct or reused drafts. */
function refineBeads(misses: boolean, sameInput: boolean, large = false) {
  const refined = inputFor(large ? largeDraft : sameInput ? beadDraft : refinedDraft, misses)
  const winner = sameInput ? refined : inputFor(beadDraft, misses)
  const result = normalizeBeadRefinementOutput(refined, winner)
  assert.ok(result.ok)
  assert.equal(result.value.beads.length, large ? beads.length : 1)
  assert.equal(result.value.changes.length, sameInput ? 0 : 1)
  assert.equal(result.value.beads[0]?.id, 'bead-1')
}

/** Return min/median/max milliseconds per pass after warming the chosen mode. */
function measure(run: (misses: boolean) => void, misses: boolean, passes: number): string {
  // Warm each mode separately so a repeated phase never includes a cold first pass.
  for (let pass = 0; pass < 20; pass++) run(misses)
  const durations: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    for (let pass = 0; pass < passes; pass++) run(misses)
    durations.push((performance.now() - start) / passes)
  }
  durations.sort((a, b) => a - b)
  return [durations[0]!, durations[Math.floor(samples / 2)]!, durations.at(-1)!]
    .map((duration) => duration.toFixed(3)).join('/')
}

const workloads = [
  ['valid corpus (7 candidates)', parseCorpus, 200],
  ['invalid candidate (uncached errors)', parseInvalid, 200],
  [`large bead parse (${largeBytes} bytes, ${beads.length} beads)`, parseLarge, 20],
  ['bead refinement (distinct drafts)', (misses: boolean) => refineBeads(misses, false), 200],
  ['bead refinement (same draft twice)', (misses: boolean) => refineBeads(misses, true), 200],
  ['large refinement (same draft twice)', (misses: boolean) => refineBeads(misses, true, true), 20],
] as const

console.log(`Node ${process.version}; ${samples} samples; milliseconds per pass, min/median/max`)
console.log('Unique/repeated inputs have equal lengths; same-draft unique passes include intra-call reuse.')
console.log('Assertions and input construction are timed. Results depend on workload and machine; no timing thresholds.')
for (const [label, run, passes] of workloads) {
  const missMs = measure(run, true, passes)
  const repeatMs = measure(run, false, passes)
  console.log(`${label} (${passes} passes/sample): unique=${missMs} ms, repeated=${repeatMs} ms`)
}
