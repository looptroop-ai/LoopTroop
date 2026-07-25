import { describe, expect, it, vi } from 'vitest'
import type { PromptPart } from '../../../opencode/types'
import { executeFinalTestWithRetries } from '../executor'
import type { FinalTestGenerationResult } from '../generator'
import type { FinalTestExecutionReport } from '../runner'
import type { CommandSpec } from '@shared/commandSpec'

function shellCommand(script: string): CommandSpec {
  return { mode: 'shell', shell: 'posix', script, cwd: '.', env: {} }
}

function buildGeneration(overrides: Partial<FinalTestGenerationResult> = {}): FinalTestGenerationResult {
  return {
    output: '<FINAL_TEST_COMMANDS>{"commands":["npm run test:final"],"test_files":["src/final.test.ts"],"modified_files":["src/final.test.ts"]}</FINAL_TEST_COMMANDS>',
    commandPlan: {
      markerFound: true,
      commands: [shellCommand('npm run test:final')],
      summary: 'verify final behavior',
      testFiles: ['src/final.test.ts'],
      modifiedFiles: ['src/final.test.ts'],
      fileEffects: [{ path: 'src/final.test.ts', intent: 'candidate' }],
      testsCount: 1,
      errors: [],
      repairApplied: false,
      repairWarnings: [],
    },
    structuredOutput: {
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 0,
    },
    ...overrides,
  }
}

function buildReport(overrides: Partial<FinalTestExecutionReport> = {}): FinalTestExecutionReport {
  return {
    status: 'passed',
    passed: true,
    checkedAt: '2026-04-09T10:00:00.000Z',
    plannedBy: 'test-vendor/test-implementer',
    summary: 'verify final behavior',
    testFiles: ['src/final.test.ts'],
    modifiedFiles: ['src/final.test.ts'],
    fileEffects: [{ path: 'src/final.test.ts', intent: 'candidate' }],
    testsCount: 1,
    modelOutput: '<FINAL_TEST_COMMANDS>{"commands":["npm run test:final"]}</FINAL_TEST_COMMANDS>',
    commands: [
      {
        command: shellCommand('npm run test:final'),
        displayCommand: 'npm run test:final',
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        durationMs: 42,
        timedOut: false,
      },
    ],
    errors: [],
    ...overrides,
  }
}

describe('executeFinalTestWithRetries', () => {
  it('passes on the first attempt without adding retry notes', async () => {
    const generatePlan = vi.fn().mockResolvedValue(buildGeneration())
    const executePlan = vi.fn().mockResolvedValue(buildReport())
    const onFailedAttempt = vi.fn()
    const beforeRetry = vi.fn()

    const result = await executeFinalTestWithRetries(
      {} as never,
      [{ type: 'text', source: 'ticket_details', content: 'Ticket context' }],
      '/tmp/project',
      undefined,
      {
        model: 'test-vendor/test-implementer',
        maxIterations: 3,
        timeoutMs: 1234,
      },
      {
        executePlan,
        onFailedAttempt,
        beforeRetry,
      },
      {
        generatePlan,
      },
    )

    expect(generatePlan).toHaveBeenCalledTimes(1)
    expect(generatePlan.mock.calls[0]?.[4]).toMatchObject({
      timeoutMs: 1234,
      phaseAttempt: 1,
      model: 'test-vendor/test-implementer',
    })
    expect(executePlan).toHaveBeenCalledTimes(1)
    expect(onFailedAttempt).not.toHaveBeenCalled()
    expect(beforeRetry).not.toHaveBeenCalled()
    expect(result.passed).toBe(true)
    expect(result.attempt).toBe(1)
    expect(result.maxIterations).toBe(3)
    expect(result.retryNotes).toEqual([])
    expect(result.attemptHistory).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'passed',
        commands: [shellCommand('npm run test:final')],
      }),
    ])
  })

  it('appends a retry note, rebuilds context, and retries from a clean callback state', async () => {
    const persistedNotes: string[] = []
    const contextSnapshots: string[][] = []
    let attemptCounter = 0

    const generatePlan = vi.fn().mockImplementation(async (_adapter, parts: PromptPart[]) => {
      attemptCounter += 1
      contextSnapshots.push(parts.map((part) => `${part.source ?? part.type}:${part.content}`))
      return buildGeneration({
        commandPlan: {
          markerFound: true,
          commands: [shellCommand(`npm run test:final --attempt=${attemptCounter}`)],
          summary: `verify final behavior attempt ${attemptCounter}`,
          testFiles: ['src/final.test.ts'],
          modifiedFiles: ['src/final.test.ts'],
          fileEffects: [{ path: 'src/final.test.ts', intent: 'candidate' }],
          testsCount: 1,
          errors: [],
          repairApplied: false,
          repairWarnings: [],
        },
      })
    })

    const executePlan = vi.fn()
      .mockResolvedValueOnce(buildReport({
        status: 'failed',
        passed: false,
        commands: [
          {
            command: shellCommand('npm run test:final --attempt=1'),
            displayCommand: 'npm run test:final --attempt=1',
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'first failure',
            durationMs: 21,
            timedOut: false,
          },
        ],
        errors: ['Command failed (1): npm run test:final --attempt=1'],
      }))
      .mockResolvedValueOnce(buildReport({
        checkedAt: '2026-04-09T10:01:00.000Z',
        commands: [
          {
            command: shellCommand('npm run test:final --attempt=2'),
            displayCommand: 'npm run test:final --attempt=2',
            exitCode: 0,
            signal: null,
            stdout: 'ok',
            stderr: '',
            durationMs: 19,
            timedOut: false,
          },
        ],
      }))

    const beforeRetry = vi.fn()

    const result = await executeFinalTestWithRetries(
      {} as never,
      async () => {
        const parts: PromptPart[] = [{ type: 'text', source: 'ticket_details', content: 'Ticket context' }]
        for (const note of persistedNotes) {
          parts.push({ type: 'text', source: 'final_test_note', content: note })
        }
        return parts
      },
      '/tmp/project',
      undefined,
      {
        model: 'test-vendor/test-implementer',
        maxIterations: 2,
        timeoutMs: 900,
      },
      {
        executePlan,
        generateRetryNote: vi.fn().mockResolvedValue('Retry note: focus on the failing status color contrast check.'),
        onFailedAttempt: ({ notes }) => {
          persistedNotes.splice(0, persistedNotes.length, ...notes)
        },
        beforeRetry,
      },
      {
        generatePlan,
      },
    )

    expect(contextSnapshots).toHaveLength(2)
    expect(contextSnapshots[0]?.some((entry) => entry.startsWith('final_test_note:'))).toBe(false)
    expect(contextSnapshots[1]).toContain('final_test_note:Retry note: focus on the failing status color contrast check.')
    expect(beforeRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      nextAttempt: 2,
      note: 'Retry note: focus on the failing status color contrast check.',
    }))
    expect(result.passed).toBe(true)
    expect(result.attempt).toBe(2)
    expect(result.retryNotes).toEqual(['Retry note: focus on the failing status color contrast check.'])
    expect(result.attemptHistory?.[0]).toMatchObject({
      attempt: 1,
      status: 'failed',
      noteAppended: 'Retry note: focus on the failing status color contrast check.',
    })
  })

  it('stops after maxIterations, preserves notes, and returns the failed report', async () => {
    const persistedNotes: string[] = []
    const generatePlan = vi.fn().mockResolvedValue(buildGeneration())
    const executePlan = vi.fn()
      .mockResolvedValueOnce(buildReport({
        status: 'failed',
        passed: false,
        commands: [
          {
            command: shellCommand('npm run test:final'),
            displayCommand: 'npm run test:final',
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'failure one',
            durationMs: 20,
            timedOut: false,
          },
        ],
        errors: ['Command failed (1): npm run test:final'],
      }))
      .mockResolvedValueOnce(buildReport({
        status: 'failed',
        passed: false,
        checkedAt: '2026-04-09T10:02:00.000Z',
        commands: [
          {
            command: shellCommand('npm run test:final'),
            displayCommand: 'npm run test:final',
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'failure two',
            durationMs: 18,
            timedOut: false,
          },
        ],
        errors: ['Command failed (1): npm run test:final'],
      }))
    const beforeRetry = vi.fn()
    const onRetriesExhausted = vi.fn()

    const result = await executeFinalTestWithRetries(
      {} as never,
      [{ type: 'text', source: 'ticket_details', content: 'Ticket context' }],
      '/tmp/project',
      undefined,
      {
        model: 'test-vendor/test-implementer',
        maxIterations: 2,
        timeoutMs: 900,
      },
      {
        executePlan,
        generateRetryNote: vi.fn()
          .mockResolvedValueOnce('Retry note 1')
          .mockResolvedValueOnce('Retry note 2'),
        onFailedAttempt: ({ notes }) => {
          persistedNotes.splice(0, persistedNotes.length, ...notes)
        },
        beforeRetry,
        onRetriesExhausted,
      },
      {
        generatePlan,
      },
    )

    expect(result.passed).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.attempt).toBe(2)
    expect(result.retryNotes).toEqual(['Retry note 1', 'Retry note 2'])
    expect(result.attemptHistory).toHaveLength(2)
    expect(beforeRetry).toHaveBeenCalledTimes(1)
    expect(onRetriesExhausted).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2,
      maxIterations: 2,
      notes: ['Retry note 1', 'Retry note 2'],
    }))
    expect(persistedNotes).toEqual(['Retry note 1', 'Retry note 2'])
  })

  it('treats maxIterations=0 as unlimited until a passing attempt occurs', async () => {
    let attempts = 0
    const generatePlan = vi.fn().mockImplementation(async () => {
      attempts += 1
      return buildGeneration({
        commandPlan: {
          markerFound: true,
          commands: [shellCommand(`npm run test:final --attempt=${attempts}`)],
          summary: 'verify final behavior',
          testFiles: ['src/final.test.ts'],
          modifiedFiles: ['src/final.test.ts'],
          fileEffects: [{ path: 'src/final.test.ts', intent: 'candidate' }],
          testsCount: 1,
          errors: [],
          repairApplied: false,
          repairWarnings: [],
        },
      })
    })
    const executePlan = vi.fn().mockImplementation(async () => (
      attempts < 3
        ? buildReport({
          status: 'failed',
          passed: false,
          commands: [
            {
              command: shellCommand(`npm run test:final --attempt=${attempts}`),
              displayCommand: `npm run test:final --attempt=${attempts}`,
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: 'retry',
              durationMs: 15,
              timedOut: false,
            },
          ],
          errors: [`Command failed (1): npm run test:final --attempt=${attempts}`],
        })
        : buildReport({
          commands: [
            {
              command: shellCommand('npm run test:final --attempt=3'),
              displayCommand: 'npm run test:final --attempt=3',
              exitCode: 0,
              signal: null,
              stdout: 'ok',
              stderr: '',
              durationMs: 14,
              timedOut: false,
            },
          ],
        })
    ))

    const result = await executeFinalTestWithRetries(
      {} as never,
      [{ type: 'text', source: 'ticket_details', content: 'Ticket context' }],
      '/tmp/project',
      undefined,
      {
        model: 'test-vendor/test-implementer',
        maxIterations: 0,
        timeoutMs: 900,
      },
      {
        executePlan,
        generateRetryNote: vi.fn().mockResolvedValue('Retry note'),
      },
      {
        generatePlan,
      },
    )

    expect(generatePlan).toHaveBeenCalledTimes(3)
    expect(result.passed).toBe(true)
    expect(result.attempt).toBe(3)
    expect(result.maxIterations).toBe(0)
    expect(result.retryNotes).toEqual(['Retry note', 'Retry note'])
  })

  it('falls back to a deterministic retry note when note generation fails', async () => {
    const result = await executeFinalTestWithRetries(
      {} as never,
      [{ type: 'text', source: 'ticket_details', content: 'Ticket context' }],
      '/tmp/project',
      undefined,
      {
        model: 'test-vendor/test-implementer',
        maxIterations: 1,
        timeoutMs: 900,
      },
      {
        executePlan: vi.fn().mockResolvedValue(buildReport({
          status: 'failed',
          passed: false,
          commands: [
            {
              command: shellCommand('npm run test:final'),
              displayCommand: 'npm run test:final',
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: 'contrast failure',
              durationMs: 17,
              timedOut: false,
            },
          ],
          errors: ['Command failed (1): npm run test:final'],
        })),
        generateRetryNote: vi.fn().mockRejectedValue(new Error('PROM53 failed')),
      },
      {
        generatePlan: vi.fn().mockResolvedValue(buildGeneration()),
      },
    )

    expect(result.passed).toBe(false)
    expect(result.retryNotes?.[0]).toContain('Attempt 1 failed.')
    expect(result.retryNotes?.[0]).toContain('Command failed (1): npm run test:final')
    expect(result.attemptHistory?.[0]?.noteAppended).toContain('Attempt 1 failed.')
  })
})
