import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { existsSync, readFileSync } from 'node:fs'
import { ticketMachine } from '../../machines/ticketMachine'
import { attachProject } from '../../storage/projects'
import { createTicket, getLatestPhaseArtifact, getTicketPaths } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import {
  TEST,
  makeTicketContextFromTicket,
} from '../../test/factories'
import { resetTestDb } from '../../test/integration'
import { initializeTicket } from '../../ticket/initialize'
import { OPENCODE_PROVIDER_AUTH_FAILED } from '@shared/errorCodes'

const { runOpenCodePromptMock, runOpenCodeSessionPromptMock } = vi.hoisted(() => ({
  runOpenCodePromptMock: vi.fn(),
  runOpenCodeSessionPromptMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../runOpenCodePrompt', () => ({
  formatPromptText: (parts: Array<{ type?: string; source?: string; content?: string }>) => {
    if (parts.length === 1 && !parts[0]?.source) return parts[0]?.content ?? ''
    return parts.map((part) => `### ${part.source ?? part.type}\n${part.content ?? ''}`).join('\n\n')
  },
  runOpenCodePrompt: runOpenCodePromptMock,
  runOpenCodeSessionPrompt: runOpenCodeSessionPromptMock,
}))

import { handleRelevantFilesScan } from '../runner'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-relevant-files-',
  files: {
    'README.md': '# Relevant Files Scan Test\n',
    'src/main.ts': 'export const main = true\n',
    'src/routes.ts': 'export const routes = []\n',
  },
})

async function createInitializedTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Harden relevant files scanning',
    description: 'Retry malformed relevant-files output and block on failure.',
  })

  await initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Expected ticket paths after initialization')

  return {
    ticket,
    context: makeTicketContextFromTicket(ticket),
    paths,
  }
}

describe('handleRelevantFilesScan', () => {
  beforeEach(() => {
    resetTestDb()
    runOpenCodePromptMock.mockReset()
    runOpenCodeSessionPromptMock.mockReset()
  })

  afterAll(() => {
    repoManager.cleanup()
  })

  it('retries once in the same session after a prompt echo and succeeds with the corrected artifact', async () => {
    const { ticket, context, paths } = await createInitializedTicket()
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'ses-1', projectPath: paths.worktreePath },
      response: [
        'CRITICAL OUTPUT RULE:',
        'Return strict machine-readable output.',
        '',
        'CONTEXT REFRESH:',
        'Use the ticket context below.',
        '',
        '## System Role',
        'You are an expert software architect.',
      ].join('\n'),
      messages: [],
    })
    runOpenCodeSessionPromptMock.mockResolvedValueOnce({
      session: { id: 'ses-1', projectPath: paths.worktreePath },
      response: [
        '<RELEVANT_FILES_RESULT>',
        '```yaml',
        'payload:',
        '  file_count: 1',
        '  files:',
        '    - filepath: src/main.ts',
        '      reason: Entry point for the feature workflow.',
        '      relevance: high',
        '      action: modify',
        '      source: |',
        '        export const main = true',
        '```',
        '</RELEVANT_FILES_RESULT>',
      ].join('\n'),
      messages: [],
    })

    await handleRelevantFilesScan(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(1)
    expect(runOpenCodeSessionPromptMock).toHaveBeenCalledTimes(1)
    expect(runOpenCodeSessionPromptMock.mock.calls[0]?.[0]).toMatchObject({
      session: { id: 'ses-1' },
      model: TEST.implementer,
      toolPolicy: 'default',
    })
    expect(runOpenCodePromptMock.mock.calls[0]?.[0]).toMatchObject({
      model: TEST.implementer,
      toolPolicy: 'default',
      timeoutKind: 'ai_response',
      timeoutMs: expect.any(Number),
    })
    expect(runOpenCodeSessionPromptMock.mock.calls[0]?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        content: expect.stringContaining('## Structured Output Retry'),
      }),
    ]))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'RELEVANT_FILES_READY' })

    const relevantFilesPath = `${paths.ticketDir}/relevant-files.yaml`
    expect(existsSync(relevantFilesPath)).toBe(true)
    const artifactYaml = readFileSync(relevantFilesPath, 'utf-8')
    expect(artifactYaml).toContain('ticket_id: LOOP-1')
    expect(artifactYaml).toContain('path: src/main.ts')
    expect(artifactYaml).toContain('likely_action: modify')

    const artifactRow = getLatestPhaseArtifact(ticket.id, 'relevant_files_scan', 'SCANNING_RELEVANT_FILES')
    expect(artifactRow).toBeDefined()
    const artifact = JSON.parse(artifactRow!.content) as {
      fileCount?: number
      files?: Array<{ path?: string }>
      structuredOutput?: {
        repairWarnings?: string[]
        interventions?: Array<{ code?: string }>
        autoRetryCount?: number
        validationError?: string
        retryDiagnostics?: Array<{
          attempt?: number
          validationError?: string
          excerpt?: string
        }>
      }
      rawAttempts?: Array<{ attempt?: number; outcome?: string; rawResponse?: string; validationError?: string; failureClass?: string }>
    }
    expect(artifact.fileCount).toBe(1)
    expect(artifact.files?.[0]?.path).toBe('src/main.ts')
    expect(artifact.structuredOutput?.repairWarnings?.length).toBe(new Set(artifact.structuredOutput?.repairWarnings ?? []).size)
    expect(artifact.structuredOutput?.interventions?.length).toBe(new Set((artifact.structuredOutput?.interventions ?? []).map((intervention) => intervention.code)).size)
    expect(artifact.structuredOutput).toMatchObject({
      autoRetryCount: 1,
      validationError: 'Relevant files output echoed the prompt instead of returning a <RELEVANT_FILES_RESULT> artifact',
    })
    expect(artifact.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Relevant files output echoed the prompt instead of returning a <RELEVANT_FILES_RESULT> artifact',
        excerpt: expect.stringContaining('CRITICAL OUTPUT RULE'),
      }),
    ])
    expect(artifact.rawAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'rejected',
        rawResponse: expect.stringContaining('CRITICAL OUTPUT RULE'),
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: 'accepted',
        rawResponse: expect.stringContaining('<RELEVANT_FILES_RESULT>'),
      }),
    ])
  })

  it('emits ERROR after the retry is exhausted so the ticket can block', async () => {
    const { ticket, context, paths } = await createInitializedTicket()
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'ses-2', projectPath: paths.worktreePath },
      response: [
        'CRITICAL OUTPUT RULE:',
        'Return strict machine-readable output.',
        '',
        'CONTEXT REFRESH:',
        'Use the ticket context below.',
      ].join('\n'),
      messages: [],
    })
    runOpenCodeSessionPromptMock.mockResolvedValueOnce({
      session: { id: 'ses-2', projectPath: paths.worktreePath },
      response: [
        '<RELEVANT_FILES_RESULT>',
        'file_count: 0',
        'files: []',
        '</RELEVANT_FILES_RESULT>',
      ].join('\n'),
      messages: [],
    })

    await handleRelevantFilesScan(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: expect.stringContaining('failed validation after 1 structured retry attempt(s)'),
      codes: ['RELEVANT_FILES_SCAN_FAILED'],
    }))
    expect(existsSync(`${paths.ticketDir}/relevant-files.yaml`)).toBe(false)
    const artifactRow = getLatestPhaseArtifact(ticket.id, 'relevant_files_scan', 'SCANNING_RELEVANT_FILES')
    expect(artifactRow).toBeDefined()
    const artifact = JSON.parse(artifactRow!.content) as {
      fileCount?: number
      structuredOutput?: {
        retryDiagnostics?: Array<{ attempt?: number; validationError?: string; excerpt?: string }>
      }
      rawAttempts?: Array<{ attempt?: number; outcome?: string; rawResponse?: string; validationError?: string }>
    }
    expect(artifact.fileCount).toBe(0)
    expect(artifact.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Relevant files output echoed the prompt instead of returning a <RELEVANT_FILES_RESULT> artifact',
        excerpt: expect.stringContaining('CRITICAL OUTPUT RULE'),
      }),
      expect.objectContaining({
        attempt: 2,
        validationError: 'Relevant files output is missing files list',
        excerpt: expect.stringContaining('files: []'),
      }),
    ])
    expect(artifact.rawAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'rejected',
        rawResponse: expect.stringContaining('CRITICAL OUTPUT RULE'),
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: 'rejected',
        validationError: 'Relevant files output is missing files list',
      }),
    ])
  })

  it('restarts the scan in a fresh session after an empty response instead of sending a structured retry prompt', async () => {
    const { ticket, context, paths } = await createInitializedTicket()
    const sendEvent = vi.fn()

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'ses-empty', projectPath: paths.worktreePath },
        response: '',
        responseMeta: {
          hasAssistantMessage: true,
          latestAssistantMessageId: 'msg-empty',
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
        },
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'ses-fresh', projectPath: paths.worktreePath },
        response: [
          '<RELEVANT_FILES_RESULT>',
          'file_count: 1',
          'files:',
          '  - path: src/main.ts',
          '    rationale: Entry point for the feature workflow.',
          '    relevance: high',
          '    likely_action: modify',
          '</RELEVANT_FILES_RESULT>',
        ].join('\n'),
        responseMeta: {
          hasAssistantMessage: true,
          latestAssistantMessageId: 'msg-fresh',
          latestAssistantWasEmpty: false,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
        },
        messages: [],
      })

    await handleRelevantFilesScan(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(runOpenCodeSessionPromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'RELEVANT_FILES_READY' })
    expect(existsSync(`${paths.ticketDir}/relevant-files.yaml`)).toBe(true)

    const artifactRow = getLatestPhaseArtifact(ticket.id, 'relevant_files_scan', 'SCANNING_RELEVANT_FILES')
    expect(artifactRow).toBeDefined()
    const artifact = JSON.parse(artifactRow!.content) as {
      structuredOutput?: {
        repairApplied?: boolean
        repairWarnings?: string[]
        interventions?: Array<{ code?: string }>
        autoRetryCount?: number
        validationError?: string
        retryDiagnostics?: Array<{
          attempt?: number
          validationError?: string
          excerpt?: string
          failureClass?: string
        }>
      }
      rawAttempts?: Array<{ attempt?: number; outcome?: string; rawResponse?: string; failureClass?: string }>
    }
    expect(artifact.structuredOutput).toMatchObject({
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 1,
      validationError: 'Relevant files output was empty.',
    })
    expect(artifact.structuredOutput?.interventions).toEqual([
      expect.objectContaining({ code: 'retry_after_validation_failure' }),
    ])
    expect(artifact.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Relevant files output was empty.',
        excerpt: '[empty response]',
        failureClass: 'empty_response',
      }),
    ])
    expect(artifact.rawAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'rejected',
        rawResponse: '',
        failureClass: 'empty_response',
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: 'accepted',
        rawResponse: expect.stringContaining('<RELEVANT_FILES_RESULT>'),
      }),
    ])
  })

  it('includes underlying provider diagnostics when retry exhaustion ends with discarded OpenCode output', async () => {
    const { ticket, context, paths } = await createInitializedTicket()
    const sendEvent = vi.fn()

    runOpenCodePromptMock
      .mockResolvedValueOnce({
        session: { id: 'ses-empty', projectPath: paths.worktreePath },
        response: '',
        responseMeta: {
          hasAssistantMessage: true,
          latestAssistantMessageId: 'msg-empty',
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
        },
        attemptMeta: {
          outcome: 'clean',
          responseAccepted: true,
          discardedResponse: false,
          sessionErrored: false,
          latestAssistantErrored: false,
        },
        messages: [],
      })
      .mockResolvedValueOnce({
        session: { id: 'ses-auth', projectPath: paths.worktreePath },
        response: '',
        responseMeta: {
          hasAssistantMessage: false,
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
          sessionErrored: true,
          sessionError: 'Provider request failed',
          sessionErrorDetails: {
            name: 'APIError',
            data: {
              message: 'Your authentication token has been invalidated. Please try signing in again.',
              statusCode: 401,
              isRetryable: false,
              responseBody: JSON.stringify({
                error: {
                  type: 'invalid_request_error',
                  code: 'token_invalidated',
                  message: 'Your authentication token has been invalidated. Please try signing in again.',
                },
              }),
            },
          },
        },
        attemptMeta: {
          outcome: 'errored_session',
          responseAccepted: false,
          discardedResponse: true,
          sessionErrored: true,
          latestAssistantErrored: false,
          errorSource: 'session_error',
          error: 'Provider request failed',
          errorDetails: {
            name: 'APIError',
            data: {
              message: 'Your authentication token has been invalidated. Please try signing in again.',
              statusCode: 401,
              isRetryable: false,
              responseBody: JSON.stringify({
                error: {
                  type: 'invalid_request_error',
                  code: 'token_invalidated',
                  message: 'Your authentication token has been invalidated. Please try signing in again.',
                },
              }),
            },
          },
        },
        messages: [],
      })

    await handleRelevantFilesScan(ticket.id, context, sendEvent, new AbortController().signal)

    expect(runOpenCodePromptMock).toHaveBeenCalledTimes(2)
    expect(runOpenCodeSessionPromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: expect.stringContaining('Relevant files scan failed validation after 1 structured retry attempt(s): Relevant files output was empty.'),
      codes: ['RELEVANT_FILES_SCAN_FAILED', OPENCODE_PROVIDER_AUTH_FAILED],
      diagnostics: expect.objectContaining({
        kind: 'opencode_provider',
        source: 'provider',
        sessionId: 'ses-auth',
        modelId: TEST.implementer,
        statusCode: 401,
        providerErrorType: 'invalid_request_error',
        providerErrorMessage: 'Your authentication token has been invalidated. Please try signing in again.',
      }),
    }))
    expect(sendEvent.mock.calls.at(-1)?.[0].message).toContain('Underlying OpenCode error: invalid_request_error')
  })

  it('blocks immediately when no main implementer is locked', async () => {
    const { ticket } = await createInitializedTicket()
    const sendEvent = vi.fn()

    await handleRelevantFilesScan(
      ticket.id,
      makeTicketContextFromTicket(ticket, { lockedMainImplementer: null }),
      sendEvent,
      new AbortController().signal,
    )

    expect(runOpenCodePromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'ERROR',
      message: 'No main implementer configured for relevant files scan.',
      codes: ['RELEVANT_FILES_SCAN_FAILED', 'MAIN_IMPLEMENTER_MISSING'],
    })
  })

  it('succeeds without retry when model output is truncated but normalizer recovers', async () => {
    const { ticket, context, paths } = await createInitializedTicket()
    const sendEvent = vi.fn()

    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'ses-trunc', projectPath: paths.worktreePath },
      response: [
        '<RELEVANT_FILES_RESULT>',
        'file_count: 3',
        'files:',
        '  - path: src/main.ts',
        '    rationale: Entry point.',
        '    relevance: high',
        '    likely_action: modify',
        '    content: |',
        '      export const main = true',
        '  - path: src/routes.ts',
        '    rationale: Routing surface.',
        '    relevance: medium',
        '    likely_action: read',
        '    content: |',
        '      export const routes = []',
        '  - path: src/broken.ts',
        '    rationale: This file entry gets cut off.',
        '    relevance: high',
        '    likely_action: modify',
        '    content: |',
        '      import { something } from "./something"',
        '    relev',
        // No closing tag — truncated mid-key at token limit
      ].join('\n'),
      messages: [],
    })

    await handleRelevantFilesScan(ticket.id, context, sendEvent, new AbortController().signal)

    // Should NOT have retried — normalizer recovered directly
    expect(runOpenCodeSessionPromptMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'RELEVANT_FILES_READY' })

    const relevantFilesPath = `${paths.ticketDir}/relevant-files.yaml`
    expect(existsSync(relevantFilesPath)).toBe(true)
    const artifactYaml = readFileSync(relevantFilesPath, 'utf-8')
    expect(artifactYaml).toContain('path: src/main.ts')
    expect(artifactYaml).toContain('path: src/routes.ts')
    // Truncated entry should NOT be in the artifact
    expect(artifactYaml).not.toContain('src/broken.ts')
  })

  it('transitions scan errors to BLOCKED_ERROR in the ticket machine', async () => {
    const { ticket } = await createInitializedTicket()
    const actor = createActor(ticketMachine, {
      input: makeTicketContextFromTicket(ticket),
    })

    actor.start()
    actor.send({ type: 'START', lockedMainImplementer: TEST.implementer })
    expect(actor.getSnapshot().value).toBe('SCANNING_RELEVANT_FILES')

    actor.send({ type: 'ERROR', message: 'Relevant files scan failed', codes: ['RELEVANT_FILES_SCAN_FAILED'] })
    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
  })
})
