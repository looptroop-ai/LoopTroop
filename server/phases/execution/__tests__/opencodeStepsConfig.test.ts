import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyOpencodeStepsConfig,
  OPENCODE_CONFIG_FILENAME,
  restoreInterruptedOpencodeStepsConfig,
  restoreOpencodeStepsConfig,
  type OpencodeStepsConfigHandle,
} from '../opencodeStepsConfig'
import { removeTempDir } from '../../../test/tempDir'

const TEST_DIR = join(tmpdir(), `looptroop-opencode-steps-${process.pid}-${Date.now()}`)
const TICKET_DIR = join(TEST_DIR, '.ticket', 'PRJ-1')
const WORKTREE_DIR = join(TEST_DIR, 'worktree')
const CONFIG_PATH = join(WORKTREE_DIR, OPENCODE_CONFIG_FILENAME)
const SIDECAR_PATH = join(TICKET_DIR, 'opencode-steps-restore.json')

function apply(steps = 25) {
  const reported: string[] = []
  const outcome = applyOpencodeStepsConfig({
    ticketDir: TICKET_DIR,
    worktreePath: WORKTREE_DIR,
    steps,
    report: (message) => { reported.push(message) },
  })
  return { outcome, reported }
}

function restore(handle: OpencodeStepsConfigHandle) {
  const reported: string[] = []
  const result = restoreOpencodeStepsConfig(handle, (message) => { reported.push(message) })
  return { result, reported }
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
}

beforeEach(() => {
  mkdirSync(TICKET_DIR, { recursive: true })
  mkdirSync(WORKTREE_DIR, { recursive: true })
})

afterEach(() => {
  removeTempDir(TEST_DIR)
})

describe('applyOpencodeStepsConfig', () => {
  it('writes the minimal document when the project has no opencode.json', () => {
    const { outcome } = apply(25)

    expect(outcome.applied).toBe(true)
    if (!outcome.applied) return
    expect(outcome.handle.created).toBe(true)
    expect(readConfig()).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: { build: { steps: 25 } },
    })
  })

  /**
   * The whole point of §1.3: a project's MCP servers, providers and other agents
   * have to survive the run, not just be restored after it.
   */
  it('keeps the project configuration in place while the run is happening', () => {
    const original = {
      $schema: 'https://opencode.ai/config.json',
      mcp: { docs: { type: 'local', command: ['docs-server'] } },
      provider: { anthropic: { options: { baseURL: 'https://example.invalid' } } },
      agent: {
        plan: { model: 'anthropic/claude-opus-4' },
        build: { model: 'anthropic/claude-sonnet-4', temperature: 0.2 },
      },
    }
    writeFileSync(CONFIG_PATH, `${JSON.stringify(original, null, 2)}\n`, 'utf8')

    const { outcome } = apply(40)

    expect(outcome.applied).toBe(true)
    if (!outcome.applied) return
    expect(outcome.handle.created).toBe(false)
    expect(readConfig()).toEqual({
      ...original,
      agent: {
        plan: original.agent.plan,
        build: { ...original.agent.build, steps: 40 },
      },
    })
  })

  it('replaces a step cap the project set for itself', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ agent: { build: { steps: 5 } } }), 'utf8')

    apply(40)

    expect(readConfig()).toEqual({ agent: { build: { steps: 40 } } })
  })

  it('leaves an unreadable configuration untouched and skips the limit', () => {
    writeFileSync(CONFIG_PATH, '{ this is not json', 'utf8')

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{ this is not json')
    expect(existsSync(SIDECAR_PATH)).toBe(false)
    expect(reported.join(' ')).toMatch(/not readable JSON/)
  })

  it('leaves a non-object configuration untouched and skips the limit', () => {
    writeFileSync(CONFIG_PATH, '["a", "b"]', 'utf8')

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('["a", "b"]')
    expect(reported.join(' ')).toMatch(/not a JSON object/)
  })

  it('skips rather than guessing when the agent section cannot hold a step cap', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ agent: 'build' }), 'utf8')

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readConfig()).toEqual({ agent: 'build' })
    expect(reported.join(' ')).toMatch(/"agent" section/)
  })

  it('never writes through a symlink', () => {
    const outside = join(TEST_DIR, 'elsewhere.json')
    writeFileSync(outside, '{"real": true}', 'utf8')
    symlinkSync(outside, CONFIG_PATH)

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('{"real": true}')
    expect(reported.join(' ')).toMatch(/symbolic link/)
  })
})

describe('restoreOpencodeStepsConfig', () => {
  it('puts the project configuration back byte for byte', () => {
    const original = '{\n  "mcp": { "docs": { "type": "local" } }\n}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')

    expect(restore(outcome.handle).result).toBe('restored')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })

  it('deletes the file only when this run created it', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')

    expect(restore(outcome.handle).result).toBe('removed')
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })

  /**
   * An edit made during the run is the user's, not ours. Overwriting it would
   * be the same class of mistake as the behaviour this replaced.
   */
  it('leaves an edit made during the run alone and keeps the original safe', () => {
    writeFileSync(CONFIG_PATH, '{"mcp": {}}\n', 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"edited": "during the run"}\n', 'utf8')

    const { result, reported } = restore(outcome.handle)

    expect(result).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"edited": "during the run"}\n')
    expect(reported.join(' ')).toMatch(/changed during this run/)
    // The record is the only remaining copy of the project's own version.
    const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')) as { originalContent: string }
    expect(sidecar.originalContent).toBe('{"mcp": {}}\n')
  })

  it('keeps a created file that was edited during the run, and its record is not worth keeping', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"mine": true}\n', 'utf8')

    expect(restore(outcome.handle).result).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"mine": true}\n')
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })
})

describe('restoreInterruptedOpencodeStepsConfig', () => {
  it('does nothing when no run was interrupted', () => {
    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR)).toBe(false)
  })

  /** A SIGKILL between the write and the cleanup: the `finally` never ran. */
  it('restores the project configuration at the next boot', () => {
    const original = '{\n  "provider": { "anthropic": {} }\n}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    apply()

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR)).toBe(true)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })

  it('removes a file the interrupted run created', () => {
    apply()

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR)).toBe(true)
    expect(existsSync(CONFIG_PATH)).toBe(false)
  })

  it('does not overwrite a file that changed while the process was down', () => {
    writeFileSync(CONFIG_PATH, '{"mcp": {}}\n', 'utf8')
    apply()
    writeFileSync(CONFIG_PATH, '{"changed": true}\n', 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR)).toBe(false)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"changed": true}\n')
    expect(existsSync(SIDECAR_PATH)).toBe(true)
  })

  it('ignores a restore record it did not write', () => {
    writeFileSync(SIDECAR_PATH, JSON.stringify({ owner: 'something-else' }), 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR)).toBe(false)
    expect(existsSync(SIDECAR_PATH)).toBe(true)
  })
})
