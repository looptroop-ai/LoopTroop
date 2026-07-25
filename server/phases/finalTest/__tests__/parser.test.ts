import { describe, expect, it } from 'vitest'
import { parseFinalTestCommands as parseFinalTestCommandsForHost } from '../parser'
import type { HostContext } from '@shared/hostContext'

const HOST: HostContext = {
  platform: 'linux',
  environment: 'native',
  arch: 'x64',
  availableShells: ['posix'],
  preferredShell: 'posix',
}
const parseFinalTestCommands = (output: string) => parseFinalTestCommandsForHost(output, HOST)

describe.concurrent('parseFinalTestCommands', () => {
  it('requires the structured final test marker', () => {
    const output = [
      'Run these commands:',
      '```bash',
      'npm test',
      '```',
    ].join('\n')

    expect(parseFinalTestCommands(output)).toEqual({
      markerFound: false,
      commands: [],
      summary: null,
      testFiles: [],
      modifiedFiles: [],
      fileEffects: [],
      testsCount: null,
      errors: ['No final test command marker found'],
      repairApplied: false,
      repairWarnings: [],
      validationError: 'No final test command marker found',
      retryDiagnostic: {
        attempt: 1,
        excerpt: '  1 | Run these commands:\n  2 | ```bash\n  3 | npm test\n  4 | ```',
        validationError: 'No final test command marker found',
      },
    })
  })

  it('normalizes a single command string inside the marker instead of scraping prose', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":"npm test"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.markerFound).toBe(true)
    expect(result.commands).toEqual([{
      mode: 'shell',
      shell: 'posix',
      script: 'npm test',
      cwd: '.',
      env: {},
    }])
    expect(result.summary).toBeNull()
    expect(result.testFiles).toEqual([])
    expect(result.modifiedFiles).toEqual([])
    expect(result.testsCount).toBeNull()
    expect(result.errors).toEqual([])
    expect(result.repairApplied).toBe(true)
  })

  it('accepts fenced YAML payloads inside the marker', () => {
    const output = [
      '<FINAL_TEST_COMMANDS>',
      '```yaml',
      'command_plan:',
      '  commands:',
      '    - npm run test:server',
      '  summary: verify structured output flows',
      '```',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n')

    const result = parseFinalTestCommands(output)
    expect(result.markerFound).toBe(true)
    expect(result.commands).toEqual([{
      mode: 'shell',
      shell: 'posix',
      script: 'npm run test:server',
      cwd: '.',
      env: {},
    }])
    expect(result.summary).toBe('verify structured output flows')
    expect(result.errors).toEqual([])
    expect(result.repairApplied).toBe(true)
  })

  it('parses test_files as an array', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":["src/test1.ts","src/test2.ts"],"summary":"run tests"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.markerFound).toBe(true)
    expect(result.testFiles).toEqual(['src/test1.ts', 'src/test2.ts'])
    expect(result.modifiedFiles).toEqual(['src/test1.ts', 'src/test2.ts'])
    expect(result.fileEffects).toEqual([
      { path: 'src/test1.ts', intent: 'candidate' },
      { path: 'src/test2.ts', intent: 'candidate' },
    ])
  })

  it('coerces a single test_files string to an array', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":"src/only.test.ts"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual(['src/only.test.ts'])
    expect(result.modifiedFiles).toEqual(['src/only.test.ts'])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Coerced test_files from string to array')
  })

  it('defaults test_files to empty array when missing', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"]}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual([])
    expect(result.modifiedFiles).toEqual([])
    expect(result.testsCount).toBeNull()
  })

  it('parses tests_count as integer', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"tests_count":5}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testsCount).toBe(5)
  })

  it('parses tests_count from string', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"tests_count":"3"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testsCount).toBe(3)
  })

  it('deduplicates test_files', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":["src/a.ts","src/a.ts","src/b.ts"]}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.modifiedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('filters empty strings from test_files', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":["src/a.ts","","  "]}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual(['src/a.ts'])
    expect(result.modifiedFiles).toEqual(['src/a.ts'])
  })

  it('recognizes test_file alias (singular)', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_file":"src/my.test.ts"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual(['src/my.test.ts'])
    expect(result.modifiedFiles).toEqual(['src/my.test.ts'])
  })

  it('parses modified_files separately from test_files', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":["src/my.test.ts"],"modified_files":["src/my.test.ts","src/feature.ts"]}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.testFiles).toEqual(['src/my.test.ts'])
    expect(result.modifiedFiles).toEqual(['src/my.test.ts', 'src/feature.ts'])
    expect(result.fileEffects).toEqual([
      { path: 'src/my.test.ts', intent: 'candidate' },
      { path: 'src/feature.ts', intent: 'candidate' },
    ])
  })

  it('coerces a single modified_files string to an array', () => {
    const output = '<FINAL_TEST_COMMANDS>{"commands":["npm test"],"test_files":["src/my.test.ts"],"modified_files":"src/feature.ts"}</FINAL_TEST_COMMANDS>'

    const result = parseFinalTestCommands(output)
    expect(result.modifiedFiles).toEqual(['src/feature.ts'])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Coerced modified_files from string to array')
  })

  it('parses explicit file effects with candidate, temporary, and unexpected intents', () => {
    const output = [
      '<FINAL_TEST_COMMANDS>',
      JSON.stringify({
        commands: ['npm test'],
        test_files: ['tests/final.spec'],
        modified_files: ['tests/final.spec'],
        file_effects: [
          { path: 'tests/final.spec', intent: 'candidate' },
          { path: 'tmp/output.log', intent: 'temporary', reason: 'created by test command' },
          { path: 'cache/state.db', intent: 'unexpected', reason: 'left dirty by tool' },
        ],
      }),
      '</FINAL_TEST_COMMANDS>',
    ].join('')

    const result = parseFinalTestCommands(output)
    expect(result.fileEffects).toEqual([
      { path: 'tests/final.spec', intent: 'candidate' },
      { path: 'tmp/output.log', intent: 'temporary', reason: 'created by test command' },
      { path: 'cache/state.db', intent: 'unexpected', reason: 'left dirty by tool' },
    ])
  })
})
