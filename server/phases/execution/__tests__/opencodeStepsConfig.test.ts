import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  applyOpencodeStepsConfig,
  getOpencodeStepsRestoreMarkerPath,
  OPENCODE_CONFIG_FILENAME,
  reapplyOpencodeStepsConfig,
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

function apply(steps = 25, protocol: 'v1' | 'v2' = 'v1') {
  const reported: string[] = []
  const outcome = applyOpencodeStepsConfig({
    ticketDir: TICKET_DIR,
    worktreePath: WORKTREE_DIR,
    steps,
    protocol,
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

/**
 * A restore record naming a file this ticket has no business touching, and
 * otherwise entirely well formed: the hash matches what is on disk, so nothing
 * but the path stands between it and a deletion.
 */
function foreignSidecar(configPath: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    owner: 'looptroop/opencode-steps',
    configPath,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    originalType: 'absent',
    originalContent: null,
    writtenSha256: createHash('sha256').update(readFileSync(configPath, 'utf8'), 'utf8').digest('hex'),
  }, null, 2)}\n`
}

beforeEach(() => {
  mkdirSync(TICKET_DIR, { recursive: true })
  mkdirSync(WORKTREE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(getOpencodeStepsRestoreMarkerPath(TICKET_DIR), { force: true })
  removeTempDir(TEST_DIR)
})

describe('applyOpencodeStepsConfig', () => {
  it('does not apply a cap when the restore sidecar points outside the ticket', () => {
    const outside = join(TEST_DIR, 'outside-restore.json')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, SIDECAR_PATH)

    expect(apply().outcome.applied).toBe(false)
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('{}\n')
  })

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

  it('writes v2 agents while preserving native, legacy, and unrelated config fields', () => {
    const original = {
      provider: { openrouter: { models: { legacy: { options: { keep: true } } } } },
      providers: { openrouter: { models: { native: { options: { keep: true } } } } },
      agents: { review: { model: 'openai/gpt-5.4' } },
      unrelated: { preserve: true },
    }
    const originalRaw = `${JSON.stringify(original)}\n`
    writeFileSync(CONFIG_PATH, originalRaw, 'utf8')

    const { outcome } = apply(40, 'v2')

    expect(outcome.applied).toBe(true)
    expect(readConfig()).toEqual({
      provider: { openrouter: { models: { legacy: { options: { keep: true } } } } },
      providers: { openrouter: { models: { native: { options: { keep: true } } } } },
      agents: { review: { model: 'openai/gpt-5.4' }, build: { steps: 40 } },
      unrelated: { preserve: true },
    })
    if (outcome.applied) expect(restore(outcome.handle).result).toBe('restored')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(originalRaw)
  })

  it('uses the v2 agents key for a new config and refuses malformed native agents', () => {
    const { outcome: created } = apply(12, 'v2')
    expect(created.applied).toBe(true)
    expect(readConfig()).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agents: { build: { steps: 12 } },
    })
    if (created.applied) restore(created.handle)

    writeFileSync(CONFIG_PATH, JSON.stringify({ agent: { build: { steps: 3 } }, agents: 'invalid' }), 'utf8')
    const { outcome, reported } = apply(15, 'v2')
    expect(outcome.applied).toBe(false)
    expect(readConfig()).toEqual({ agent: { build: { steps: 3 } }, agents: 'invalid' })
    expect(reported.join(' ')).toMatch(/"agents" section/)
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

  it.each([
    ['an array', { agent: { build: ['a', 'b'] } }],
    ['null', { agent: { build: null } }],
    ['a number', { agent: { build: 42 } }],
  ])('skips when the agent.build section is %s', (_label, config) => {
    writeFileSync(CONFIG_PATH, JSON.stringify(config), 'utf8')

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readConfig()).toEqual(config)
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

  it.skipIf(process.platform === 'win32')('keeps the restore record owner-only', () => {
    writeFileSync(CONFIG_PATH, '{"provider": {"anthropic": {"apiKey": "secret"}}}\n', 'utf8')

    apply()

    expect(statSync(SIDECAR_PATH).mode & 0o777).toBe(0o600)
  })

  /**
   * The record holds the only copy of the project's own bytes once a run ends in
   * conflict. Overwriting it with a second run's record would lose them, and
   * would file the edited file as though the project had written it.
   */
  it('refuses to start over an unresolved record from an earlier run', () => {
    writeFileSync(CONFIG_PATH, '{"mcp": {}}\n', 'utf8')
    const first = apply()
    if (!first.outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"edited": "during the run"}\n', 'utf8')
    restore(first.outcome.handle)

    const { outcome, reported } = apply()

    expect(outcome.applied).toBe(false)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"edited": "during the run"}\n')
    expect(reported.join(' ')).toMatch(/still waiting/)
    const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')) as { originalContent: string }
    expect(sidecar.originalContent).toBe('{"mcp": {}}\n')
  })

  it('settles a record left by a run that never got as far as writing the file', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const first = apply()
    if (!first.outcome.applied) throw new Error('expected the step cap to apply')
    // The state a kill between the two writes leaves behind.
    writeFileSync(CONFIG_PATH, original, 'utf8')

    const { outcome } = apply()

    expect(outcome.applied).toBe(true)
    expect(readConfig()).toEqual({ mcp: {}, agent: { build: { steps: 25 } } })
  })

  it('clears a temp file an interrupted write left beside the config', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    const exitedWriter = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
    if (!exitedWriter.pid) throw new Error('expected the exited writer to have a pid')
    const strayTemp = `${CONFIG_PATH}.${exitedWriter.pid}.a1b2c3d4e5f6.tmp`
    writeFileSync(strayTemp, '{"half":', 'utf8')
    const stale = new Date(Date.now() - 120_000)
    utimesSync(strayTemp, stale, stale)

    restore(outcome.handle)

    expect(existsSync(strayTemp)).toBe(false)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
  })

  it('keeps a fresh writer temp and a symlink temp visible', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')

    const freshTemp = `${CONFIG_PATH}.${process.pid}.a1b2c3d4e5f6.tmp`
    writeFileSync(freshTemp, '{"in-flight": true}\n', 'utf8')
    const outside = join(TEST_DIR, 'outside-temp.json')
    writeFileSync(outside, '{"outside": true}\n', 'utf8')
    const symlinkTemp = `${CONFIG_PATH}.4821.f1e2d3c4b5a6.tmp`
    if (process.platform === 'win32') return
    symlinkSync(outside, symlinkTemp)

    restore(outcome.handle)

    expect(existsSync(freshTemp)).toBe(true)
    expect(lstatSync(symlinkTemp).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('{"outside": true}\n')
    expect(readFileSync(symlinkTemp, 'utf8')).toBe('{"outside": true}\n')
    rmSync(freshTemp)
    rmSync(symlinkTemp)
  })

  it('keeps invalid and unknown writer PIDs visible', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')

    const invalidPidTemp = `${CONFIG_PATH}.0.a1b2c3d4e5f6.tmp`
    const unknownErrorTemp = `${CONFIG_PATH}.123456.a1b2c3d4e5f7.tmp`
    writeFileSync(invalidPidTemp, '{"invalid": true}\n', 'utf8')
    writeFileSync(unknownErrorTemp, '{"unknown": true}\n', 'utf8')
    const stale = new Date(Date.now() - 120_000)
    utimesSync(invalidPidTemp, stale, stale)
    utimesSync(unknownErrorTemp, stale, stale)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456) {
        const error = Object.assign(new Error('permission state unknown'), { code: 'EACCES' })
        throw error
      }
      return true
    })

    try {
      restore(outcome.handle)
      expect(existsSync(invalidPidTemp)).toBe(true)
      expect(existsSync(unknownErrorTemp)).toBe(true)
    } finally {
      kill.mockRestore()
      rmSync(invalidPidTemp)
      rmSync(unknownErrorTemp)
    }
  })

  /**
   * The settling pass at the start of a run deletes and overwrites the path the
   * record names, so it is checked here too, not only at boot.
   */
  it('refuses an authoritative record naming a file outside this ticket\'s worktree', () => {
    const outside = join(TEST_DIR, 'not-mine.json')
    writeFileSync(outside, '{"someone else": true}\n', 'utf8')
    const markerPath = getOpencodeStepsRestoreMarkerPath(TICKET_DIR)
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, foreignSidecar(outside), 'utf8')

    const { outcome } = apply(25)

    expect(readFileSync(outside, 'utf8')).toBe('{"someone else": true}\n')
    // The authoritative foreign record is not permission to overwrite either
    // its named file or this ticket's config. Preserve it for diagnosis.
    expect(outcome.applied).toBe(false)
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(existsSync(markerPath)).toBe(true)
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

  it('recovers when the mutable sidecar is missing', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    rmSync(SIDECAR_PATH)

    const { result, reported } = restore(outcome.handle)

    expect(result).toBe('removed')
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(reported).toEqual([])
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

  it('keeps ownership evidence for an edited file this run created across a retry', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"mine": true}\n', 'utf8')

    expect(restore(outcome.handle).result).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"mine": true}\n')
    expect(existsSync(SIDECAR_PATH)).toBe(true)

    const retry = apply()
    expect(retry.outcome.applied).toBe(false)
    expect(retry.reported.join(' ')).toMatch(/earlier run's copy|still waiting/)
    expect(existsSync(SIDECAR_PATH)).toBe(true)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"mine": true}\n')

    rmSync(CONFIG_PATH)
    expect(apply().outcome.applied).toBe(true)
  })

  /**
   * The cleanup at the end of a run reads the record too, and it is the path
   * that gets deleted. A record swapped for one naming another file while the
   * run was going must not take that file with it.
   */
  it('refuses an authoritative record naming a file outside this ticket\'s worktree', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    const outside = join(TEST_DIR, 'not-mine.json')
    writeFileSync(outside, '{"someone else": true}\n', 'utf8')
    const markerPath = getOpencodeStepsRestoreMarkerPath(TICKET_DIR)
    writeFileSync(markerPath, foreignSidecar(outside), 'utf8')

    expect(restore(outcome.handle).result).toBe('conflict')
    expect(existsSync(CONFIG_PATH)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('{"someone else": true}\n')
  })
})

describe('restoreInterruptedOpencodeStepsConfig', () => {
  it('does not restore from a sidecar linked outside the ticket', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    const outside = join(TEST_DIR, 'outside-restore.json')
    renameSync(SIDECAR_PATH, outside)
    const originalRecord = readFileSync(outside, 'utf8')
    symlinkSync(outside, SIDECAR_PATH)

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('removed')
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe(originalRecord)
    expect(existsSync(SIDECAR_PATH)).toBe(true)
  })

  it('still restores through a sidecar alias contained in the ticket', () => {
    apply()
    const destination = join(TICKET_DIR, 'original-restore.json')
    renameSync(SIDECAR_PATH, destination)
    symlinkSync(destination, SIDECAR_PATH)

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('removed')
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(existsSync(destination)).toBe(true)
  })

  it('does nothing when no run was interrupted', () => {
    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('nothing-to-do')
  })

  /** A SIGKILL between the write and the cleanup: the `finally` never ran. */
  it('restores the project configuration at the next boot', () => {
    const original = '{\n  "provider": { "anthropic": {} }\n}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    apply()

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('restored')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })

  it('removes a file the interrupted run created', () => {
    apply()

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('removed')
    expect(existsSync(CONFIG_PATH)).toBe(false)
  })

  it('does not overwrite a file that changed while the process was down', () => {
    writeFileSync(CONFIG_PATH, '{"mcp": {}}\n', 'utf8')
    apply()
    writeFileSync(CONFIG_PATH, '{"changed": true}\n', 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"changed": true}\n')
    expect(existsSync(SIDECAR_PATH)).toBe(true)
  })

  it('ignores a restore record it did not write', () => {
    writeFileSync(SIDECAR_PATH, JSON.stringify({ owner: 'something-else' }), 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('nothing-to-do')
    expect(existsSync(SIDECAR_PATH)).toBe(true)
  })

  /**
   * A restore record lives in the worktree, so anything running there — the
   * model included — can write one. The path it names is deleted or overwritten
   * at boot, so it is checked against the ticket's real worktree first.
   */
  it('refuses a record naming a file outside this ticket\'s worktree', () => {
    const outside = join(TEST_DIR, 'not-mine.json')
    writeFileSync(outside, '{"someone else": true}\n', 'utf8')
    writeFileSync(SIDECAR_PATH, foreignSidecar(outside), 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('nothing-to-do')
    expect(readFileSync(outside, 'utf8')).toBe('{"someone else": true}\n')
  })

  it('rejects a record whose fields do not agree with each other', () => {
    const markerPath = getOpencodeStepsRestoreMarkerPath(TICKET_DIR)
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      owner: 'looptroop/opencode-steps',
      configPath: CONFIG_PATH,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      // Says a file was there, carries nothing to put back: restoring would
      // write an empty document over a real configuration.
      originalType: 'file',
      originalContent: null,
      writtenSha256: createHash('sha256').update('anything', 'utf8').digest('hex'),
    }, null, 2)}\n`, 'utf8')
    writeFileSync(CONFIG_PATH, 'anything', 'utf8')

    // The owner/schema pair proves this feature started a restore, but the
    // bytes are not trustworthy. Keep the record and cap visible rather than
    // treating corruption as permission to overwrite the project's file.
    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('anything')
    expect(existsSync(markerPath)).toBe(true)
  })

  /** The state a kill between the record and the configuration write leaves. */
  it('does not report a false conflict when the file is already the project\'s own', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, original, 'utf8')

    expect(restoreInterruptedOpencodeStepsConfig(TICKET_DIR, WORKTREE_DIR)).toBe('nothing-to-do')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
    // Nothing left to warn about at every future boot.
    expect(existsSync(SIDECAR_PATH)).toBe(false)
  })
})

describe('reapplyOpencodeStepsConfig', () => {
  /** `git reset --hard` puts a tracked config back, cap and all. */
  it('puts the cap back after a worktree reset', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply(30)
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, original, 'utf8')

    reapplyOpencodeStepsConfig(outcome.handle)

    expect(readConfig()).toEqual({ mcp: {}, agent: { build: { steps: 30 } } })
    // Same bytes as the first application, so the record still describes the file.
    expect(restore(outcome.handle).result).toBe('restored')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
  })

  it('does not write through a symlink that appeared during the run', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    const outside = join(TEST_DIR, 'link-target.json')
    writeFileSync(outside, '{"real": true}', 'utf8')
    rmSync(CONFIG_PATH)
    symlinkSync(outside, CONFIG_PATH)

    expect(() => reapplyOpencodeStepsConfig(outcome.handle)).toThrow(/active retry was stopped/)

    expect(readFileSync(outside, 'utf8')).toBe('{"real": true}')
  })

  /**
   * Only a state the reset itself could have produced is written over. An edit
   * is not one: writing the cap back over it would make the file match the
   * restore record again, and the cleanup would then revert the edit as though
   * this run had written it.
   */
  it('leaves an edit made during the run alone', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply(30)
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"edited": "during the run"}\n', 'utf8')

    const reported: string[] = []
    expect(() => reapplyOpencodeStepsConfig(outcome.handle, (message) => { reported.push(message) }))
      .toThrow(/active retry was stopped/)

    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"edited": "during the run"}\n')
    expect(reported.join(' ')).toMatch(/was edited after this run wrote it/)
    // The project's own version is still the one waiting to be put back.
    expect(restore(outcome.handle).result).toBe('conflict')
    const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')) as { originalContent: string }
    expect(sidecar.originalContent).toBe(original)
  })

  /**
   * The same rule for a file the run created, where the consequence is worse:
   * rewriting it would let the cleanup delete somebody's file outright.
   */
  it('leaves an edit to a file this run created alone, and the cleanup then keeps it', () => {
    const { outcome } = apply()
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, '{"mine": true}\n', 'utf8')

    expect(() => reapplyOpencodeStepsConfig(outcome.handle)).toThrow(/active retry was stopped/)

    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"mine": true}\n')
    expect(restore(outcome.handle).result).toBe('conflict')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe('{"mine": true}\n')
  })

  /**
   * A deletion is not a state the reset produces — it puts a tracked file back,
   * and `preservePaths` stops an untracked one being cleaned away — so an
   * absent file is somebody having deleted it. Writing the cap back would make
   * the file match the restore record again, and the cleanup would then undo
   * the deletion by putting the project's version back.
   */
  it('leaves a deletion made during the run alone, so the cleanup does not undo it', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply(30)
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    rmSync(CONFIG_PATH)

    const reported: string[] = []
    expect(() => reapplyOpencodeStepsConfig(outcome.handle, (message) => { reported.push(message) }))
      .toThrow(/active retry was stopped/)

    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(reported.join(' ')).toMatch(/was removed after this run wrote it/)
    // And the cleanup respects the deletion rather than reversing it, keeping
    // the project's own version where it can still be recovered by hand.
    expect(restore(outcome.handle).result).toBe('conflict')
    expect(existsSync(CONFIG_PATH)).toBe(false)
    const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')) as { originalContent: string }
    expect(sidecar.originalContent).toBe(original)
  })

  it('stops the active retry when the authoritative restore marker has gone', () => {
    const original = '{"mcp": {}}\n'
    writeFileSync(CONFIG_PATH, original, 'utf8')
    const { outcome } = apply(30)
    if (!outcome.applied) throw new Error('expected the step cap to apply')
    writeFileSync(CONFIG_PATH, original, 'utf8')
    rmSync(SIDECAR_PATH)
    rmSync(getOpencodeStepsRestoreMarkerPath(TICKET_DIR), { force: true })

    const reported: string[] = []
    expect(() => reapplyOpencodeStepsConfig(outcome.handle, (message) => { reported.push(message) }))
      .toThrow(/authoritative restore marker .* is missing.*active retry was stopped/s)

    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(original)
    expect(reported.join(' ')).toContain(getOpencodeStepsRestoreMarkerPath(TICKET_DIR))
  })
})
