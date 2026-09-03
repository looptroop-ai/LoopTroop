import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  GenericMessagePart,
  HealthStatus,
  Message,
  MessageInfo,
  MessagePart,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionInfo,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  OpenCodeTodo,
  PromptPart,
  PromptSessionOptions,
  ReasoningMessagePart,
  SessionErrorStreamEvent,
  Session,
  StepFinishMessagePart,
  StreamEvent,
  TextMessagePart,
  ToolMessagePart,
} from './types'
import { parseModelRef } from './types'
import { isPermissionDeniedByRules } from './toolPolicy'
import type { TicketState } from './contextBuilder'
import { resolve } from 'path'
import { relative, sep } from 'path'
import { existsSync, lstatSync } from 'fs'
import { pathToFileURL } from 'url'
import { logIfVerbose, warnIfVerbose } from '../runtime'
import { getOpenCodeBaseUrl } from './runtimeConfig'
import type { Bead } from '../phases/beads/types'
import { readBeadsFile } from '../phases/beads/beadsFile'
import { parseExecutionSetupPlanNotes } from '../phases/executionSetupPlan/types'
import { parseExecutionSetupRetryNotes } from '../phases/executionSetup/types'
import { renderCommandSpec } from '@shared/commandSpec'
import { looksLikePromptEcho } from '../lib/promptEcho'
import { getOpenCodeBasicAuthHeader } from '../../shared/opencodeAuth'
import {
  ADAPTER_RETRY_DELAY_MS,
  SDK_OPERATION_TIMEOUT_MS,
  SESSION_LIST_LIMIT,
  MESSAGE_LIST_LIMIT,
  MAX_CATALOG_MODEL_IDS,
} from '../lib/constants'
import {
  analyzeAssistantMessages,
  extractTextFromMessageParts,
} from './assistantMessageAnalysis'
import { summarizeModelErrorForLog } from './errorDetails'
import { enrichGenericOpenCodeProviderError } from './logDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

interface RawEvent {
  type: string
  properties?: Record<string, unknown>
  directory?: string
  project?: string
  workspace?: string
}

function normalizeSafeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export interface OpenCodeAdapter {
  createSession(projectPath: string, signal?: AbortSignal, options?: OpenCodeSessionCreateOptions): Promise<Session>
  promptSession(
    sessionId: string,
    parts: PromptPart[],
    signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string>
  getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null>
  listSessions(signal?: AbortSignal): Promise<Session[]>
  getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<Message[]>
  subscribeToEvents(sessionId: string, signal?: AbortSignal, stepFinishSafetyMs?: number): AsyncGenerator<StreamEvent>
  listPendingQuestions(projectPath?: string, signal?: AbortSignal): Promise<OpenCodeQuestionRequest[]>
  replyQuestion(requestId: string, answers: OpenCodeQuestionAnswer[], projectPath?: string, signal?: AbortSignal): Promise<void>
  rejectQuestion(requestId: string, projectPath?: string, signal?: AbortSignal): Promise<void>
  abortSession(sessionId: string): Promise<boolean>
  assembleBeadContext(ticketId: string, beadId: string): Promise<PromptPart[]>
  assembleCouncilContext(ticketId: string, phase: string): Promise<PromptPart[]>
  checkHealth(): Promise<HealthStatus>
}

function formatContextGuidance(guidance: Bead['contextGuidance']): string {
  const lines: string[] = []
  if (guidance.patterns.length > 0) {
    lines.push('Patterns:')
    for (const pattern of guidance.patterns) lines.push(`- ${pattern}`)
  }
  if (guidance.anti_patterns.length > 0) {
    lines.push('Anti-patterns:')
    for (const antiPattern of guidance.anti_patterns) lines.push(`- ${antiPattern}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No additional guidance provided.'
}

function formatBeadContext(bead: Bead): string {
  const blockedBy = bead.dependencies.blocked_by
  const manualQa = bead.qaOrigin
    ? [
        '',
        '## Manual QA Fix Origin',
        `Round: v${bead.qaOrigin.version}`,
        ...bead.qaOrigin.sourceItems.flatMap((item) => [
          `- Item ${item.itemId}: ${item.behavior}`,
          `  Observation: ${item.observation}`,
          `  Expected: ${item.expectedResult}`,
          ...(item.evidence.length > 0
            ? item.evidence.map((evidence) => `  Evidence: ${evidence.originalName} (${evidence.mediaType}, sha256 ${evidence.sha256}, ${evidence.relativePath})`)
            : ['  Evidence: none']),
          ...item.links.map((link) => `  Evidence link: ${link.label ? `${link.label}: ` : ''}${link.url}`),
        ]),
        'Retry notes are separate from this Manual QA origin.',
      ]
    : []
  return [
    `# Active Bead`,
    `ID: ${bead.id}`,
    `Title: ${bead.title}`,
    '',
    `## Description`,
    bead.description,
    '',
    `## Context Guidance`,
    formatContextGuidance(bead.contextGuidance),
    '',
    `## Acceptance Criteria`,
    ...bead.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    `## Target Files`,
    ...(bead.targetFiles.length > 0 ? bead.targetFiles.map((item) => `- ${item}`) : ['- No target files listed.']),
    '',
    `## Required Tests`,
    ...bead.tests.map((item) => `- ${item}`),
    '',
    `## Test Commands`,
    ...bead.testCommands.map((item) => `- ${renderCommandSpec(item)}`),
    '',
    `## Dependencies (blocked by)`,
    ...(blockedBy.length > 0 ? blockedBy.map((item) => `- ${item}`) : ['- None']),
    ...manualQa,
  ].join('\n')
}

export class OpenCodeSDKAdapter implements OpenCodeAdapter {
  private client: ReturnType<typeof createOpencodeClient>
  private sessionDirectories = new Map<string, string>()
  private recentDirectoryEventKeys = new Map<string, number>()

  constructor(baseUrlOrPort: string | number = getOpenCodeBaseUrl(), client?: ReturnType<typeof createOpencodeClient>) {
    const baseUrl = typeof baseUrlOrPort === 'number'
      ? `http://localhost:${baseUrlOrPort}`
      : baseUrlOrPort
    const authHeader = getOpenCodeBasicAuthHeader()
    this.client = client ?? createOpencodeClient({
      baseUrl,
      ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    })
  }

  async createSession(
    projectPath: string,
    signal?: AbortSignal,
    options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    try {
      const res = await this.client.session.create(
        {
          directory: projectPath,
          ...(options?.permission ? { permission: options.permission.map((rule) => ({ ...rule })) } : {}),
        },
        this.requestOptions(this.withSdkOperationTimeout(signal)),
      )
      if (!res.data) throw new Error('OpenCode returned no session payload')
      const session = this.mapSession(res.data as Record<string, unknown>)
      this.sessionDirectories.set(session.id, projectPath)
      return session
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || signal?.aborted)) throw err
      const errorMessage = getErrorMessage(err)
      if (options?.permission) {
        throw new Error(
          `Failed to create OpenCode session with allow-all permissions: ${errorMessage}. ` +
          'Allow-all sessions require an OpenCode server that supports session-scoped permissions. ' +
          'Upgrade OpenCode and restart `opencode serve`.',
        )
      }
      throw new Error(
        `Failed to create OpenCode session: ${errorMessage}`,
      )
    }
  }

  async promptSession(
    sessionId: string,
    parts: PromptPart[],
    signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string> {
    const promptSignal = options?.signal ?? signal
    const promptOptions = {
      ...options,
      signal: promptSignal,
    }
    const sdkPromptAbortController = new AbortController()
    const sdkPromptSignal = promptSignal
      ? AbortSignal.any([promptSignal, sdkPromptAbortController.signal])
      : sdkPromptAbortController.signal
    const model = promptOptions.model ?? parseModelRef(promptOptions.modelRef)

    const directory = await this.resolveSessionDirectory(sessionId, promptSignal)
    if (promptOptions.permission) {
      try {
        const res = await this.client.session.update({
          sessionID: sessionId,
          ...(directory ? { directory } : {}),
          permission: promptOptions.permission.map(rule => ({ ...rule })),
        }, this.requestOptions(this.withSdkOperationTimeout(promptSignal)))
        if (!res.data) throw new Error('OpenCode returned no updated session payload')
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || promptSignal?.aborted)) throw error
        throw new Error(
          `Failed to apply OpenCode session permissions: ${getErrorMessage(error)}. ` +
          'Session permission updates require a current OpenCode server; upgrade OpenCode and restart `opencode serve`.',
        )
      }
    }
    // Manual QA file parts carry a creation-time model-capability snapshot.
    // If present, forward every part; provider/context failures must surface.
    const { systemText, promptParts } = this.partitionPromptParts(parts, promptOptions.system, true)
    const streamAbortController = new AbortController()
    const streamSignal = promptSignal
      ? AbortSignal.any([promptSignal, streamAbortController.signal])
      : streamAbortController.signal
    const streamedTextByMessage = new Map<string, Map<string, string>>()
    const streamedTextMessageOrder: string[] = []
    const streamedTextPartIndex = new Map<string, string>()
    let latestTextMessageId: string | undefined
    let latestSessionErrorEvent: SessionErrorStreamEvent | undefined
    const rememberStreamText = (event: StreamEvent) => {
      if (event.type === 'session_error') {
        latestSessionErrorEvent = event
        return
      }

      if (event.type === 'text') {
        const messageId = event.messageId ?? '__stream__'
        const partId = event.partId ?? `${messageId}:text`
        let messageParts = streamedTextByMessage.get(messageId)
        if (!messageParts) {
          messageParts = new Map<string, string>()
          streamedTextByMessage.set(messageId, messageParts)
          streamedTextMessageOrder.push(messageId)
        }
        messageParts.set(partId, event.text)
        streamedTextPartIndex.set(partId, messageId)
        latestTextMessageId = messageId
        return
      }

      if (event.type === 'part_removed' && event.partId) {
        const messageId = streamedTextPartIndex.get(event.partId)
        if (!messageId) return
        const messageParts = streamedTextByMessage.get(messageId)
        if (!messageParts) return
        messageParts.delete(event.partId)
        streamedTextPartIndex.delete(event.partId)
        if (messageParts.size > 0) return
        streamedTextByMessage.delete(messageId)
        const orderIndex = streamedTextMessageOrder.lastIndexOf(messageId)
        if (orderIndex >= 0) streamedTextMessageOrder.splice(orderIndex, 1)
        latestTextMessageId = streamedTextMessageOrder[streamedTextMessageOrder.length - 1]
      }
    }
    const buildStreamedTextResponse = (): string => {
      if (!latestTextMessageId) return ''
      const messageParts = streamedTextByMessage.get(latestTextMessageId)
      if (!messageParts || messageParts.size === 0) return ''
      return Array.from(messageParts.values()).join('').trim()
    }
    let resolveStreamDoneResponse: ((value: string | null) => void) | null = null
    let resolveStreamClosed: (() => void) | null = null
    let streamDoneObserved = false
    const streamDoneResponse = new Promise<string | null>((resolve) => {
      resolveStreamDoneResponse = resolve
    })
    const streamClosed = new Promise<void>((resolve) => {
      resolveStreamClosed = resolve
    })
    const handledPermissionIds = new Set<string>()
    let permissionReplyFailure: Error | null = null
    const streamDrain = this.consumeStreamEvents(
      sessionId,
      async (event) => {
        rememberStreamText(event)
        promptOptions.onEvent?.(event)
        if (
          event.type === 'permission'
          && event.action === 'asked'
          && promptOptions.autoApprovePermissions
          && event.permissionId
          && !handledPermissionIds.has(event.permissionId)
        ) {
          handledPermissionIds.add(event.permissionId)
          // Auto-approval is for keeping an unattended run moving, not for
          // overriding the policy it was given. A permission the rules deny is
          // rejected here even so: `question` is denied whenever the operator
          // has asking turned off, and blanket-approving an ask for it would
          // quietly hand the model back the thing the setting took away.
          const deniedByPolicy = isPermissionDeniedByRules(promptOptions.permission, event.permission)
          try {
            const result = await this.client.permission.reply({
              requestID: event.permissionId,
              ...(directory ? { directory } : {}),
              reply: deniedByPolicy ? 'reject' : 'always',
            }, this.requestOptions(this.withSdkOperationTimeout(promptSignal)))
            if (!result.data) throw new Error('OpenCode did not confirm the permission reply')
          } catch (error) {
            permissionReplyFailure = new Error(
              // Names the reply that failed rather than assuming approval: this
              // path now rejects too, and "failed to auto-approve" would be a
              // misleading thing to read in a log about a denied permission.
              `Failed to ${deniedByPolicy ? 'reject' : 'auto-approve'} OpenCode permission ${event.permission ?? event.permissionId}: ${getErrorMessage(error)}`,
            )
            sdkPromptAbortController.abort(permissionReplyFailure)
            await this.abortSession(sessionId).catch(() => false)
            throw permissionReplyFailure
          }
        }
        if (event.type !== 'done' || streamDoneObserved) return
        streamDoneObserved = true
        void this.readAssistantSnapshotWithRetry(sessionId)
          .then((snapshot) => {
            resolveStreamDoneResponse?.(snapshot.responseText || buildStreamedTextResponse() || null)
          })
          .catch((err) => {
            warnIfVerbose('[adapter] Snapshot retry failed after stream done, falling back to streamed text', err)
            resolveStreamDoneResponse?.(buildStreamedTextResponse() || null)
          })
      },
      streamSignal,
      promptOptions.stepFinishSafetyMs,
    ).finally(() => {
      resolveStreamClosed?.()
    })
    const readSnapshotAfterStreamClose = async (): Promise<string> => {
      await streamClosed
      if (streamDoneObserved) {
        return (await streamDoneResponse)?.trim() ?? ''
      }
      try {
        const snapshot = await this.readAssistantSnapshotWithRetry(sessionId)
        return (snapshot.responseText || buildStreamedTextResponse()).trim()
      } catch (err) {
        warnIfVerbose('[adapter] Snapshot retry failed after stream close, falling back to streamed text', err)
        return buildStreamedTextResponse().trim()
      }
    }

    try {
      const sdkPromptResponse = (async () => {
        const res = await this.client.session.prompt({
          sessionID: sessionId,
          ...(directory ? { directory } : {}),
          ...(model ? { model } : {}),
          ...(promptOptions.agent ? { agent: promptOptions.agent } : {}),
          ...(promptOptions.variant ? { variant: promptOptions.variant } : {}),
          ...(systemText ? { system: systemText } : {}),
          ...(typeof promptOptions.noReply === 'boolean' ? { noReply: promptOptions.noReply } : {}),
          ...('tools' in promptOptions && promptOptions.tools ? { tools: promptOptions.tools as Record<string, boolean> } : {}),
          parts: promptParts,
        }, this.requestOptions(sdkPromptSignal))

        let responseText = extractTextFromMessageParts(res.data?.parts)
        if (!responseText) {
          const preferredMessageId = typeof this.getRecord(res.data?.info)?.id === 'string'
            ? String(this.getRecord(res.data?.info)?.id)
            : undefined
          responseText = (await this.readAssistantSnapshotWithRetry(sessionId, preferredMessageId)).responseText
        }
        if (!responseText) {
          responseText = buildStreamedTextResponse()
        }
        return responseText
      })()

      const streamFirstResponse = streamDoneResponse.then((snapshot) => {
        if (snapshot) {
          sdkPromptAbortController.abort()
          // Suppress the rejection from the now-aborted SDK prompt — the stream
          // already provided the response so this rejection is expected.
          void sdkPromptResponse.catch(() => undefined)
          return snapshot
        }
        return sdkPromptResponse
      })

      // If the caller's signal fires (e.g. deadline timeout), break the race
      // so promptSession doesn't hang when the SDK client ignores the signal.
      const signalAbort = promptSignal
        ? new Promise<string>((_, reject) => {
            if (promptSignal.aborted) {
              reject(new DOMException('The operation was aborted', 'AbortError'))
              return
            }
            promptSignal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'))
            }, { once: true })
          })
        : null

      let responseText = await Promise.race([
        sdkPromptResponse,
        streamFirstResponse,
        ...(signalAbort ? [signalAbort] : []),
      ])
      if (permissionReplyFailure) throw permissionReplyFailure
      if (responseText && looksLikePromptEcho(responseText) && !streamDoneObserved) {
        const terminalResponse = await Promise.race([
          streamDoneResponse.then((snapshot) => snapshot?.trim() ?? ''),
          readSnapshotAfterStreamClose(),
          ...(signalAbort ? [signalAbort] : []),
        ])
        if (terminalResponse) {
          responseText = terminalResponse
        }
      }
      if (!responseText) {
        responseText = buildStreamedTextResponse()
      }
      if (!responseText && latestSessionErrorEvent) {
        const summary = summarizeModelErrorForLog(
          latestSessionErrorEvent.details ?? latestSessionErrorEvent.error,
          latestSessionErrorEvent.error,
        )
        const error = new Error(summary.message)
        Object.assign(error, {
          details: latestSessionErrorEvent.details,
          sessionError: latestSessionErrorEvent.error,
          modelErrorDetails: summary.details,
        })
        error.name = 'OpenCodeSessionError'
        throw error
      }
      if (!responseText) {
        warnIfVerbose(`[adapter] promptSession: OpenCode returned empty response for session=${sessionId}`)
      }
      return responseText
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || promptOptions.signal?.aborted)) throw err
      if (err instanceof Error && err.name === 'OpenCodeSessionError') throw err
      const enriched = enrichGenericOpenCodeProviderError(err, sessionId)
      if (enriched) {
        const error = new Error(`Failed to prompt OpenCode session: ${enriched.message}`)
        Object.assign(error, {
          details: enriched.details,
          modelErrorDetails: enriched.details,
        })
        throw error
      }
      throw new Error(
        `Failed to prompt OpenCode session: ${getErrorMessage(err)}`,
      )
    } finally {
      streamAbortController.abort()
      await this.waitForStreamDrain(streamDrain)
    }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const res = await this.client.session.list(
      { limit: SESSION_LIST_LIMIT },
      this.requestOptions(this.withSdkOperationTimeout(signal)),
    )
    return Array.isArray(res.data)
      ? res.data.map(session => this.mapSession(session as Record<string, unknown>))
      : []
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    try {
      const res = await this.client.session.get(
        { sessionID: sessionId },
        this.requestOptions(this.withSdkOperationTimeout(signal)),
      )
      if (!res.data) {
        const status = res.response?.status
        if (status === 404) return null
        if (res.error) throw res.error
        if (typeof status === 'number') {
          throw new Error(`OpenCode session lookup failed with HTTP ${status}`)
        }
        throw new Error('OpenCode returned no session payload')
      }
      const session = this.mapSession(res.data as Record<string, unknown>)
      if (session.directory) this.sessionDirectories.set(session.id, session.directory)
      return session
    } catch (err) {
      if (this.isSessionNotFoundError(err)) return null
      throw err
    }
  }

  async getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<Message[]> {
    try {
      const directory = await this.resolveSessionDirectory(sessionId, signal)
      const res = await this.client.session.messages(
        {
          sessionID: sessionId,
          ...(directory ? { directory } : {}),
          limit: MESSAGE_LIST_LIMIT,
        },
        this.requestOptions(this.withSdkOperationTimeout(signal)),
      )
      return Array.isArray(res.data)
        ? res.data.map((entry) => this.mapMessageRecord(entry, sessionId))
        : []
    } catch {
      return []
    }
  }

  async listPendingQuestions(projectPath?: string, signal?: AbortSignal): Promise<OpenCodeQuestionRequest[]> {
    const res = await this.client.question.list(
      projectPath ? { directory: projectPath } : undefined,
      this.requestOptions(this.withSdkOperationTimeout(signal)),
    )
    return Array.isArray(res.data)
      ? res.data.map((request) => this.mapQuestionRequest(request)).filter((request): request is OpenCodeQuestionRequest => Boolean(request))
      : []
  }

  async replyQuestion(
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    projectPath?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.question.reply({
      requestID: requestId,
      ...(projectPath ? { directory: projectPath } : {}),
      answers,
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
  }

  async rejectQuestion(requestId: string, projectPath?: string, signal?: AbortSignal): Promise<void> {
    await this.client.question.reject({
      requestID: requestId,
      ...(projectPath ? { directory: projectPath } : {}),
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      const directory = await this.resolveSessionDirectory(sessionId)
      await this.client.session.abort({
        sessionID: sessionId,
        ...(directory ? { directory } : {}),
      }, this.requestOptions(AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)))
      this.sessionDirectories.delete(sessionId)
      return true
    } catch {
      return false
    }
  }

  async *subscribeToEvents(sessionId: string, signal?: AbortSignal, stepFinishSafetyMs?: number): AsyncGenerator<StreamEvent> {
    const directory = await this.resolveSessionDirectory(sessionId, signal)
    const eventStream = await this.client.global.event(this.requestOptions(signal))

    const partCache = new Map<string, GenericMessagePart>()
    const finalizedPartIds = new Set<string>()
    const messageRoles = new Map<string, string>()
    let emittedDone = false
    let lastStatus: string | undefined
    let safetyActive = false
    let shouldEmitSyntheticDone = false

    const rawIterator = (eventStream.stream as AsyncIterable<RawEvent>)[Symbol.asyncIterator]()

    while (true) {
      if (signal?.aborted) break

      let result: IteratorResult<RawEvent>

      if (safetyActive && stepFinishSafetyMs) {
        const nextPromise = rawIterator.next()
        const expired = Symbol('expired')
        const winner = await Promise.race([
          nextPromise,
          new Promise<typeof expired>((resolve) =>
            setTimeout(() => resolve(expired), stepFinishSafetyMs),
          ),
        ])
        if (winner === expired) {
          // Stream hung after step-finish — suppress pending iterator rejection
          void nextPromise.catch(() => undefined)
          shouldEmitSyntheticDone = true
          break
        }
        result = winner
      } else {
        result = await rawIterator.next()
      }

      if (result.done) {
        shouldEmitSyntheticDone = safetyActive
        break
      }

      const rawEvent = this.unwrapRawEvent(result.value)
      if (!rawEvent) continue

      if (!this.eventBelongsToSession(rawEvent, sessionId, directory)) continue

      const normalized = this.normalizeStreamEvent(rawEvent, sessionId, partCache, finalizedPartIds, messageRoles)
      if (!normalized) continue

      if (normalized.type === 'session_status') {
        if (normalized.status === lastStatus) continue
        lastStatus = normalized.status
      }

      yield normalized

      if (normalized.type === 'done') {
        emittedDone = true
        break
      }

      // Activate safety deadline after step-finish with terminal reason
      if (
        normalized.type === 'step' &&
        normalized.step === 'finish' &&
        (normalized.reason === 'stop' || normalized.reason === 'end_turn')
      ) {
        safetyActive = true
      }
    }

    if (!emittedDone && !signal?.aborted && shouldEmitSyntheticDone) {
      yield { type: 'done', sessionId }
    }
  }

  async assembleBeadContext(ticketId: string, beadId: string): Promise<PromptPart[]> {
    const { buildMinimalContext } = await import('./contextBuilder')
    const ticketState = await this.loadTicketState(ticketId, beadId)
    logIfVerbose(`[adapter] assembleBeadContext ticket=${ticketId} bead=${beadId} hasDescription=${!!ticketState.description}`)
    const context = buildMinimalContext('coding', ticketState)
    return [...context, ...await this.loadQaEvidenceFileParts(ticketId, beadId)]
  }

  async assembleCouncilContext(ticketId: string, phase: string): Promise<PromptPart[]> {
    const { buildMinimalContext } = await import('./contextBuilder')
    const ticketState = await this.loadTicketState(ticketId)
    logIfVerbose(`[adapter] assembleCouncilContext ticket=${ticketId} phase=${phase} hasDescription=${!!ticketState.description} hasRelevantFiles=${!!ticketState.relevantFiles}`)
    return buildMinimalContext(phase, ticketState)
  }

  private async loadTicketState(ticketId: string, beadId?: string): Promise<TicketState> {
    const { existsSync, readFileSync } = await import('fs')
    const { getLatestPhaseArtifact, getTicketContext, getTicketPaths } = await import('../storage/tickets')

    const state: TicketState = { ticketId }

    const ticket = getTicketContext(ticketId)
    if (ticket) {
      state.title = ticket.localTicket.title
      state.description = ticket.localTicket.description ?? undefined
    } else {
      warnIfVerbose(`[adapter] loadTicketState: ticket not found in DB for id=${ticketId}`)
    }

    const paths = getTicketPaths(ticketId)
    if (!paths) return state
    const ticketDir = paths.ticketDir

    const artifactLoaders: { file: string; field: 'interview' | 'prd' }[] = [
      { file: 'interview.yaml', field: 'interview' },
      { file: 'prd.yaml', field: 'prd' },
    ]

    for (const { file, field } of artifactLoaders) {
      const filePath = resolve(ticketDir, file)
      if (!existsSync(filePath)) continue
      try {
        state[field] = readFileSync(filePath, 'utf-8')
      } catch (err) {
        warnIfVerbose(`[adapter] Failed to read ${file}:`, err)
      }
    }

    const beadsPath = paths.beadsPath
    const executionSetupProfilePath = paths.executionSetupProfilePath
    const executionSetupPlanArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')
    if (executionSetupPlanArtifact?.content) {
      state.executionSetupPlan = executionSetupPlanArtifact.content
    }

    const executionSetupPlanNotesArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_plan_notes', 'WAITING_EXECUTION_SETUP_APPROVAL')
    state.executionSetupPlanNotes = parseExecutionSetupPlanNotes(executionSetupPlanNotesArtifact?.content)

    if (existsSync(executionSetupProfilePath)) {
      try {
        state.executionSetupProfile = readFileSync(executionSetupProfilePath, 'utf-8')
      } catch (err) {
        warnIfVerbose('[adapter] Failed to read execution setup profile:', err)
      }
    }

    const executionSetupNotesArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_retry_notes', 'PREPARING_EXECUTION_ENV')
    state.executionSetupNotes = parseExecutionSetupRetryNotes(executionSetupNotesArtifact?.content)

    if (existsSync(beadsPath)) {
      try {
        const beadFile = readFileSync(beadsPath, 'utf-8')
        state.beads = beadFile

        if (beadId) {
          // The raw file text above is what the prompt shows; the bead itself is
          // read through the reconciler, so a legacy stored status does not reach
          // `formatBeadContext` unrecognised and a malformed line does not abort
          // the whole read.
          const bead = readBeadsFile(beadsPath).find((entry) => entry.id === beadId)

          if (bead) {
            state.beadData = formatBeadContext(bead)
            const formatHistory = (title: string, entries: Bead['failedIterationNotes']) => {
              if (entries.length === 0) return null
              return [
                `## ${title}`,
                ...entries.map((entry) => [
                  `### Iteration ${entry.iteration} — ${entry.timestamp}`,
                  entry.errorCode ? `Error code: ${entry.errorCode}` : '',
                  entry.content,
                ].filter(Boolean).join('\n')),
              ].join('\n\n')
            }
            state.beadNotes = [
              formatHistory('Failed Iteration Notes', bead.failedIterationNotes),
              formatHistory('User Retry Notes', bead.userRetryNotes),
              formatHistory('Finalization Failure Notes', bead.finalizationFailureNotes),
            ].filter((entry): entry is string => Boolean(entry))
          }
        }
      } catch (err) {
        warnIfVerbose(`[adapter] Failed to read issues.jsonl:`, err)
      }
    }

    return state
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      const health = await this.client.global.health(this.requestOptions(AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)))
      const version = health.data?.version ? String(health.data.version) : 'unknown'
      const providers = await this.withSdkPromiseTimeout(this.client.config.providers())
      return {
        available: true,
        version,
        models: this.extractConnectedModelIds(providers.data),
      }
    } catch {
      // fall through to session fallback
    }
    try {
      await this.client.session.status(undefined, this.requestOptions(AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)))
      return { available: true, version: 'unknown', models: [] }
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }
    }
  }

  private requestOptions(signal?: AbortSignal) {
    return signal ? { signal } : undefined
  }

  private withSdkOperationTimeout(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }

  private async withSdkPromiseTimeout<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeoutSignal = this.withSdkOperationTimeout(signal)
    if (timeoutSignal.aborted) {
      throw timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error('OpenCode SDK operation timed out')
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error('OpenCode SDK operation timed out'))
      }
      timeoutSignal.addEventListener('abort', onAbort, { once: true })
      operation
        .then(resolve, reject)
        .finally(() => timeoutSignal.removeEventListener('abort', onAbort))
    })
  }

  private mapSession(session: Record<string, unknown>): Session {
    const time = this.getRecord(session.time)
    return {
      id: String(session.id),
      slug: typeof session.slug === 'string' ? session.slug : undefined,
      projectPath: typeof session.directory === 'string' ? session.directory : undefined,
      directory: typeof session.directory === 'string' ? session.directory : undefined,
      createdAt: typeof time?.created === 'number' ? new Date(time.created).toISOString() : undefined,
      updatedAt: typeof time?.updated === 'number' ? new Date(time.updated).toISOString() : undefined,
      title: typeof session.title === 'string' ? session.title : undefined,
      version: typeof session.version === 'string' ? session.version : undefined,
    }
  }

  private partitionPromptParts(parts: PromptPart[], fallbackSystem?: string, includeImageFiles = false) {
    const systemParts = parts
      .filter(part => part.type === 'system')
      .map(part => part.content.trim())
      .filter(Boolean)

    const promptParts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; mime: string; filename?: string; url: string }
    > = []
    for (const part of parts) {
      if (part.type === 'system') continue
      if (part.type === 'file') {
        if (!includeImageFiles || !part.url || !part.mime?.toLowerCase().startsWith('image/')) continue
        promptParts.push({
          type: 'file',
          mime: part.mime,
          ...(part.filename ? { filename: part.filename } : {}),
          url: part.url,
        })
        continue
      }
      promptParts.push({ type: 'text', text: part.content })
    }

    return {
      systemText: [fallbackSystem?.trim(), ...systemParts].filter(Boolean).join('\n\n'),
      promptParts: promptParts.length > 0 ? promptParts : [{ type: 'text' as const, text: '' }],
    }
  }

  private async loadQaEvidenceFileParts(ticketId: string, beadId: string): Promise<PromptPart[]> {
    const { getTicketPaths } = await import('../storage/tickets')
    const paths = getTicketPaths(ticketId)
    if (!paths || !existsSync(paths.beadsPath)) return []
    let bead: Bead | undefined
    try {
      // Authoritative read: this manifest decides which evidence images the
      // prompt carries, so a dropped line has to be an error rather than an
      // image that quietly does not arrive.
      bead = readBeadsFile(paths.beadsPath, { malformedEntries: 'fail' }).find((entry) => entry.id === beadId)
    } catch (error) {
      throw new Error(`Failed to load Manual QA evidence manifest for bead ${beadId}: ${getErrorMessage(error)}`)
    }
    if (!bead?.qaOrigin || bead.qaOrigin.imageDelivery !== 'attached') return []
    return bead.qaOrigin.sourceItems.flatMap((item) => item.evidence.flatMap((evidence) => {
      if (!evidence.mediaType.toLowerCase().startsWith('image/')) return []
      const localPath = resolve(paths.ticketDir, evidence.relativePath)
      const rel = relative(paths.ticketDir, localPath)
      let safeFile = false
      try {
        const stats = lstatSync(localPath)
        safeFile = rel !== '..'
          && !rel.startsWith(`..${sep}`)
          && existsSync(localPath)
          && !stats.isSymbolicLink()
          && stats.isFile()
      } catch {
        safeFile = false
      }
      if (!safeFile) {
        throw new Error(`Manual QA image evidence ${evidence.id} for bead ${beadId} is missing or unsafe: ${evidence.relativePath}`)
      }
      return [{
        type: 'file' as const,
        content: '',
        source: `manual_qa_evidence:${item.itemId}:${evidence.id}`,
        url: pathToFileURL(localPath).href,
        mime: evidence.mediaType,
        filename: evidence.originalName,
      }]
    }))
  }

  private async readAssistantSnapshotWithRetry(
    sessionId: string,
    preferredMessageId?: string,
    maxAttempts = 4,
    delayMs = 75,
  ): Promise<ReturnType<typeof analyzeAssistantMessages>> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const messages = await this.getSessionMessages(sessionId)
      const analysis = analyzeAssistantMessages(messages, preferredMessageId)
      if (analysis.responseText || analysis.responseMeta.latestAssistantHasError || analysis.responseMeta.latestAssistantWasStale) {
        return analysis
      }
      if (attempt >= maxAttempts) break
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }

    return {
      responseText: '',
      responseMeta: {
        hasAssistantMessage: false,
        latestAssistantWasEmpty: true,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
      },
    }
  }

  private mapMessageRecord(entry: unknown, sessionId?: string): Message {
    const record = this.getRecord(entry)
    const rawInfo = this.getRecord(record?.info) as MessageInfo | null
    const info = rawInfo ? { ...rawInfo } : null
    if (info?.error) {
      const enriched = enrichGenericOpenCodeProviderError(info.error, sessionId ?? info.sessionID)
      if (enriched) info.error = enriched.details
    }
    const parts = Array.isArray(record?.parts) ? record.parts as MessagePart[] : []
    const createdAt = typeof info?.time?.created === 'number'
      ? new Date(info.time.created).toISOString()
      : typeof info?.timestamp === 'string'
        ? info.timestamp
        : undefined
    const content = extractTextFromMessageParts(parts)

    return {
      id: typeof info?.id === 'string' ? info.id : '',
      role: typeof info?.role === 'string' ? info.role : undefined,
      content: content || undefined,
      timestamp: createdAt,
      info: info ?? undefined,
      parts,
    }
  }

  private async resolveSessionDirectory(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.sessionDirectories.get(sessionId)
    if (cached) return cached

    try {
      return (await this.getSession(sessionId, signal))?.directory
    } catch {
      return undefined
    }
  }

  private async consumeStreamEvents(
    sessionId: string,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
    stepFinishSafetyMs?: number,
  ) {
    try {
      for await (const event of this.subscribeToEvents(sessionId, signal, stepFinishSafetyMs)) {
        await onEvent(event)
        if (event.type === 'done') break
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return
      }
      await onEvent({
        type: 'session_error',
        sessionId,
        error: getErrorMessage(error),
        details: error,
      })
    }
  }

  private async waitForStreamDrain(streamDrain: Promise<void> | null) {
    if (!streamDrain) return
    await Promise.race([
      streamDrain,
      new Promise<void>(resolve => setTimeout(resolve, ADAPTER_RETRY_DELAY_MS)),
    ])
  }

  private eventBelongsToSession(event: RawEvent, sessionId: string, sessionDirectory?: string): boolean {
    this.pruneRecentDirectoryEventKeys()
    const props = event.properties ?? {}
    const part = this.getRecord(props.part)
    const info = this.getRecord(props.info)

    const eventSessionId = typeof props.sessionID === 'string'
      ? props.sessionID
      : typeof info?.sessionID === 'string'
        ? info.sessionID
        : typeof part?.sessionID === 'string'
          ? part.sessionID
          : event.type.startsWith('session.') && typeof info?.id === 'string'
            ? info.id
            : undefined

    if (eventSessionId) return eventSessionId === sessionId
    if (!this.isSessionAgnosticDebugEvent(event.type)) return false
    if (sessionDirectory && event.directory && event.directory !== sessionDirectory) return false

    const dedupeKey = `${event.directory ?? ''}:${event.workspace ?? ''}:${event.type}:${this.safeStableStringify(props)}`
    if (this.recentDirectoryEventKeys.has(dedupeKey)) return false
    this.recentDirectoryEventKeys.set(dedupeKey, Date.now())
    return true
  }

  private normalizeStreamEvent(
    event: RawEvent,
    sessionId: string,
    partCache: Map<string, GenericMessagePart>,
    finalizedPartIds: Set<string>,
    messageRoles: Map<string, string>,
  ): StreamEvent | null {
    const props = event.properties ?? {}

    switch (event.type) {
      case 'message.updated':
        this.rememberMessageRole(props.info ?? props.message, messageRoles)
        return null

      case 'message.part.updated': {
        const part = this.getRecord(props.part) as GenericMessagePart | null
        if (!part?.id) return null
        if (this.isKnownNonAssistantMessagePart(part, messageRoles)) return null
        const partId = String(part.id)
        if (finalizedPartIds.has(partId)) return null

        const nextPart = this.clonePart(part)
        const previousPart = partCache.get(partId)
        if (previousPart && !this.hasMeaningfulPartUpdate(previousPart, nextPart)) {
          return null
        }

        partCache.set(partId, nextPart)
        const normalized = this.mapPartUpdate(nextPart)
        if (normalized && 'complete' in normalized && normalized.complete) {
          finalizedPartIds.add(partId)
        }
        return normalized
      }

      case 'message.part.delta': {
        const partId = typeof props.partID === 'string' ? props.partID : undefined
        const delta = typeof props.delta === 'string' ? props.delta : ''
        if (!partId || !delta) return null
        if (finalizedPartIds.has(partId)) return null
        const part = partCache.get(partId)
        if (!part) return null
        if (this.isKnownNonAssistantMessagePart(part, messageRoles)) return null
        return this.mapPartDelta(part, delta)
      }

      case 'message.part.removed': {
        const partId = typeof props.partID === 'string' ? props.partID : undefined
        if (partId) {
          partCache.delete(partId)
          finalizedPartIds.delete(partId)
        }
        return {
          type: 'part_removed',
          sessionId,
          partId,
        }
      }

      case 'session.status': {
        const status = this.getRecord(props.status)
        const statusType = typeof status?.type === 'string' ? status.type : 'busy'
        const rawAction = this.getRecord(status?.action)
        const actionLink = typeof rawAction?.link === 'string'
          ? normalizeSafeHttpUrl(rawAction.link)
          : undefined
        const action = rawAction
          ? {
              ...(typeof rawAction.reason === 'string' ? { reason: rawAction.reason } : {}),
              ...(typeof rawAction.provider === 'string' ? { provider: rawAction.provider } : {}),
              ...(typeof rawAction.title === 'string' ? { title: rawAction.title } : {}),
              ...(typeof rawAction.message === 'string' ? { message: rawAction.message } : {}),
              ...(typeof rawAction.label === 'string' ? { label: rawAction.label } : {}),
              ...(actionLink ? { link: actionLink } : {}),
            }
          : undefined
        return {
          type: 'session_status',
          sessionId,
          status: statusType === 'retry' ? 'retry' : (statusType === 'idle' ? 'idle' : 'busy'),
          attempt: typeof status?.attempt === 'number' ? status.attempt : undefined,
          message: typeof status?.message === 'string' ? status.message : undefined,
          next: typeof status?.next === 'number' ? status.next : undefined,
          ...(action && Object.keys(action).length > 0 ? { action } : {}),
        }
      }

      case 'session.error': {
        const rawError = props.error ?? props
        const enriched = enrichGenericOpenCodeProviderError(rawError, sessionId)
        return {
          type: 'session_error',
          sessionId,
          error: enriched?.message ?? this.describeError(rawError),
          details: enriched?.details ?? rawError,
        }
      }

      case 'question.asked': {
        const request = this.mapQuestionRequest(props)
        if (!request) return null
        return {
          type: 'question',
          action: 'asked',
          sessionId: request.sessionID,
          requestId: request.id,
          questions: request.questions,
          tool: request.tool,
        }
      }

      case 'question.replied': {
        const requestId = typeof props.requestID === 'string' ? props.requestID : ''
        const answers = Array.isArray(props.answers)
          ? props.answers
              .filter((answer): answer is unknown[] => Array.isArray(answer))
              .map((answer) => answer.filter((item): item is string => typeof item === 'string'))
          : undefined
        return {
          type: 'question',
          action: 'replied',
          sessionId,
          requestId,
          ...(answers ? { answers } : {}),
        }
      }

      case 'question.rejected':
        return {
          type: 'question',
          action: 'rejected',
          sessionId,
          requestId: typeof props.requestID === 'string' ? props.requestID : '',
        }

      case 'todo.updated': {
        const todos = this.mapTodos(props.todos)
        return todos.length > 0
          ? { type: 'todo', sessionId, todos }
          : null
      }

      case 'permission.asked':
      case 'permission.replied':
      case 'permission.updated': {
        const details = this.getRecord(props)
        return {
          type: 'permission',
          action: event.type === 'permission.asked'
            ? 'asked'
            : event.type === 'permission.replied'
              ? 'replied'
              : 'updated',
          sessionId,
          permissionId: typeof details?.id === 'string' ? details.id : '',
          permission: typeof details?.permission === 'string' ? details.permission : undefined,
          title: typeof details?.title === 'string' ? details.title : undefined,
          patterns: Array.isArray(details?.patterns)
            ? details.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
            : undefined,
          details: details ?? undefined,
        }
      }

      case 'session.idle':
        return { type: 'done', sessionId }

      case 'session.compacted':
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'workspace.ready':
      case 'workspace.restore':
      case 'workspace.status':
      case 'server.connected':
      case 'server.instance.disposed':
      case 'global.disposed':
      case 'command.executed':
      case 'vcs.branch.updated':
        return this.mapDebugEvent(event, sessionId)

      case 'workspace.failed':
        return this.mapDebugEvent(event, sessionId, 'error')

      case 'file.edited': {
        const file = typeof props.file === 'string' ? props.file : ''
        return file ? { type: 'file_edited', sessionId, file } : null
      }

      default:
        return null
    }
  }

  private rememberMessageRole(value: unknown, messageRoles: Map<string, string>) {
    const info = this.getRecord(value)
    const messageId = typeof info?.id === 'string'
      ? info.id
      : typeof info?.messageID === 'string'
        ? info.messageID
        : undefined
    const role = typeof info?.role === 'string' ? info.role : undefined
    if (messageId && role) messageRoles.set(messageId, role)
  }

  private isKnownNonAssistantMessagePart(part: GenericMessagePart, messageRoles: Map<string, string>) {
    const messageId = typeof part.messageID === 'string' ? part.messageID : undefined
    if (!messageId) return false
    const role = messageRoles.get(messageId)
    return role !== undefined && role !== 'assistant'
  }

  private isToolPart(part: GenericMessagePart): part is GenericMessagePart & ToolMessagePart {
    return part.type === 'tool'
  }

  private isStepFinishPart(part: GenericMessagePart): part is GenericMessagePart & StepFinishMessagePart {
    return part.type === 'step-finish'
  }

  private mapPartUpdate(part: GenericMessagePart): StreamEvent | null {
    const sessionId = String(part.sessionID)
    const messageId = String(part.messageID)
    const partId = String(part.id)

    if (part.type === 'text') {
      const textPart = part as TextMessagePart
      if (!textPart.text && !textPart.time?.end) return null
      return {
        type: 'text',
        sessionId,
        messageId,
        partId,
        text: textPart.text ?? '',
        streaming: !textPart.time?.end,
        complete: Boolean(textPart.time?.end),
      }
    }

    if (part.type === 'reasoning') {
      const reasoningPart = part as ReasoningMessagePart
      if (!reasoningPart.text && !reasoningPart.time?.end) return null
      return {
        type: 'reasoning',
        sessionId,
        messageId,
        partId,
        text: reasoningPart.text ?? '',
        streaming: !reasoningPart.time?.end,
        complete: Boolean(reasoningPart.time?.end),
      }
    }

    if (this.isToolPart(part)) {
      const input = this.getRecord(part.state.input)
      const time = this.getRecord(part.state.time)
      const start = typeof time?.start === 'number' ? time.start : undefined
      const end = typeof time?.end === 'number' ? time.end : undefined
      const attachments = Array.isArray(part.state.attachments)
        ? part.state.attachments.flatMap((attachment) => {
            const record = this.getRecord(attachment)
            if (!record) return []
            const filename = typeof record.filename === 'string'
              ? record.filename
              : typeof record.name === 'string'
                ? record.name
                : undefined
            const mime = typeof record.mime === 'string'
              ? record.mime
              : typeof record.mediaType === 'string'
                ? record.mediaType
                : undefined
            return filename || mime
              ? [{ ...(filename ? { filename } : {}), ...(mime ? { mime } : {}) }]
              : []
          })
        : undefined
      return {
        type: 'tool',
        sessionId,
        messageId,
        partId,
        tool: part.tool,
        callId: part.callID,
        status: part.state.status,
        title: part.state.title,
        input: input ? { ...input } : undefined,
        output: typeof part.state.output === 'string' ? part.state.output : undefined,
        error: typeof part.state.error === 'string' ? part.state.error : undefined,
        metadata: part.metadata,
        ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {}),
        ...(typeof time?.compacted === 'number' ? { compactedAt: time.compacted } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        complete: part.state.status === 'completed' || part.state.status === 'error',
      }
    }

    if (part.type === 'step-start') {
      return {
        type: 'step',
        sessionId,
        messageId,
        partId,
        step: 'start',
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : undefined,
        complete: true,
      }
    }

    if (this.isStepFinishPart(part)) {
      return {
        type: 'step',
        sessionId,
        messageId,
        partId,
        step: 'finish',
        reason: part.reason,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : undefined,
        cost: typeof part.cost === 'number' ? part.cost : undefined,
        tokens: part.tokens,
        complete: true,
      }
    }

    if (this.isCompactPartType(part.type)) {
      return this.mapCompactPartUpdate(part, sessionId, messageId, partId)
    }

    return null
  }

  private mapPartDelta(part: GenericMessagePart, delta: string): StreamEvent | null {
    const sessionId = String(part.sessionID)
    const messageId = String(part.messageID)
    const partId = String(part.id)
    const nextText = `${typeof part.text === 'string' ? part.text : ''}${delta}`
    part.text = nextText

    if (part.type === 'reasoning') {
      return {
        type: 'reasoning',
        sessionId,
        messageId,
        partId,
        text: nextText,
        delta,
        streaming: true,
        complete: false,
      }
    }

    if (part.type === 'text') {
      return {
        type: 'text',
        sessionId,
        messageId,
        partId,
        text: nextText,
        delta,
        streaming: true,
        complete: false,
      }
    }

    return null
  }

  private clonePart(part: GenericMessagePart): GenericMessagePart {
    return typeof structuredClone === 'function'
      ? structuredClone(part)
      : JSON.parse(JSON.stringify(part)) as GenericMessagePart
  }

  private isCompactPartType(type: string): type is 'file' | 'patch' | 'snapshot' | 'agent' | 'subtask' | 'retry' | 'compaction' {
    return type === 'file'
      || type === 'patch'
      || type === 'snapshot'
      || type === 'agent'
      || type === 'subtask'
      || type === 'retry'
      || type === 'compaction'
  }

  private mapCompactPartUpdate(
    part: GenericMessagePart,
    sessionId: string,
    messageId: string,
    partId: string,
  ): StreamEvent | null {
    const partType = part.type
    if (!this.isCompactPartType(partType)) return null
    const summary = this.summarizeCompactPart(part)
    if (!summary) return null
    return {
      type: 'part_summary',
      sessionId,
      messageId,
      partId,
      partType,
      summary,
      details: this.compactPartDetails(part),
      severity: partType === 'retry' ? 'error' : 'info',
      complete: true,
    }
  }

  private summarizeCompactPart(part: GenericMessagePart): string {
    switch (part.type) {
      case 'file': {
        const filename = typeof part.filename === 'string' ? part.filename : undefined
        const mime = typeof part.mime === 'string' ? part.mime : undefined
        const source = this.getRecord(part.source)
        const sourcePath = typeof source?.path === 'string' ? source.path : undefined
        return `File attached: ${filename ?? sourcePath ?? 'unnamed file'}${mime ? ` (${mime})` : ''}.`
      }
      case 'patch': {
        const files = Array.isArray(part.files) ? part.files.filter((file): file is string => typeof file === 'string') : []
        const shown = files.slice(0, 6)
        const hash = typeof part.hash === 'string' ? part.hash.slice(0, 12) : undefined
        return `Patch prepared${hash ? ` ${hash}` : ''}: ${files.length} file${files.length === 1 ? '' : 's'}${shown.length ? ` (${shown.join(', ')}${files.length > shown.length ? ', …' : ''})` : ''}.`
      }
      case 'snapshot': {
        const snapshot = typeof part.snapshot === 'string' ? part.snapshot.slice(0, 16) : undefined
        return `Snapshot captured${snapshot ? `: ${snapshot}` : ''}.`
      }
      case 'agent': {
        const name = typeof part.name === 'string' ? part.name : 'agent'
        return `Agent context selected: ${name}.`
      }
      case 'subtask': {
        const description = typeof part.description === 'string' ? part.description : undefined
        const agent = typeof part.agent === 'string' ? part.agent : undefined
        const command = typeof part.command === 'string' ? part.command : undefined
        return [
          `Subtask started${agent ? ` for ${agent}` : ''}${description ? `: ${this.truncateInline(description, 160)}` : '.'}`,
          command ? `Command: ${this.truncateInline(command, 160)}` : '',
        ].filter(Boolean).join('\n')
      }
      case 'retry': {
        const attempt = typeof part.attempt === 'number' ? part.attempt : undefined
        return `Retry requested${attempt !== undefined ? ` (attempt ${attempt})` : ''}: ${this.describeError(part.error)}`
      }
      case 'compaction': {
        const mode = part.auto === true ? 'auto' : 'manual'
        const overflow = part.overflow === true ? ' after context overflow' : ''
        return `Context compaction (${mode})${overflow}.`
      }
      default:
        return ''
    }
  }

  private compactPartDetails(part: GenericMessagePart): Record<string, unknown> {
    const details: Record<string, unknown> = { partType: part.type }
    for (const key of ['filename', 'mime', 'url', 'hash', 'files', 'snapshot', 'name', 'agent', 'command', 'attempt', 'auto', 'overflow', 'tail_start_id']) {
      if (part[key] !== undefined) details[key] = part[key]
    }
    if (part.type === 'retry' && part.error !== undefined) details.error = part.error
    return details
  }

  private hasMeaningfulPartUpdate(previous: GenericMessagePart, next: GenericMessagePart) {
    return this.buildPartStreamKey(previous) !== this.buildPartStreamKey(next)
  }

  private buildPartStreamKey(part: GenericMessagePart): string {
    if (part.type === 'text' || part.type === 'reasoning') {
      return JSON.stringify({
        type: part.type,
        text: typeof part.text === 'string' ? part.text : '',
        end: this.getRecord(part.time)?.end ?? null,
      })
    }

    if (this.isToolPart(part)) {
      return JSON.stringify({
        type: part.type,
        callId: part.callID,
        tool: part.tool,
        status: part.state?.status ?? null,
        title: part.state?.title ?? null,
        input: part.state?.input ?? null,
        output: part.state?.output ?? null,
        error: part.state?.error ?? null,
      })
    }

    if (part.type === 'step-start') {
      return JSON.stringify({
        type: part.type,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : null,
      })
    }

    if (this.isStepFinishPart(part)) {
      return JSON.stringify({
        type: part.type,
        reason: part.reason,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : null,
        cost: typeof part.cost === 'number' ? part.cost : null,
        tokens: part.tokens ?? null,
      })
    }

    return JSON.stringify(part)
  }

  private unwrapRawEvent(value: RawEvent | { payload?: unknown; directory?: unknown; project?: unknown; workspace?: unknown }): RawEvent | null {
    const eventRecord = this.getRecord(value)
    if (!eventRecord) return null

    const payload = this.getRecord(eventRecord.payload)
    if (payload && typeof payload.type === 'string') {
      const payloadProps = this.getRecord(payload.properties)
      return {
        type: payload.type,
        properties: payloadProps ?? {},
        directory: typeof eventRecord.directory === 'string' ? eventRecord.directory : undefined,
        project: typeof eventRecord.project === 'string' ? eventRecord.project : undefined,
        workspace: typeof eventRecord.workspace === 'string' ? eventRecord.workspace : undefined,
      }
    }

    if (typeof eventRecord.type !== 'string') return null
    const properties = this.getRecord(eventRecord.properties)
    return {
      type: eventRecord.type,
      properties: properties ?? {},
      directory: typeof eventRecord.directory === 'string' ? eventRecord.directory : undefined,
      project: typeof eventRecord.project === 'string' ? eventRecord.project : undefined,
      workspace: typeof eventRecord.workspace === 'string' ? eventRecord.workspace : undefined,
    }
  }

  private mapQuestionRequest(value: unknown): OpenCodeQuestionRequest | null {
    const record = this.getRecord(value)
    if (!record) return null
    const id = typeof record.id === 'string' ? record.id : undefined
    const sessionID = typeof record.sessionID === 'string' ? record.sessionID : undefined
    if (!id || !sessionID) return null

    const questions = Array.isArray(record.questions)
      ? record.questions.map((question) => this.mapQuestionInfo(question)).filter((question): question is OpenCodeQuestionInfo => Boolean(question))
      : []
    const toolRecord = this.getRecord(record.tool)
    const tool = typeof toolRecord?.messageID === 'string' && typeof toolRecord.callID === 'string'
      ? { messageID: toolRecord.messageID, callID: toolRecord.callID }
      : undefined

    return {
      id,
      sessionID,
      questions,
      ...(tool ? { tool } : {}),
    }
  }

  private mapQuestionInfo(value: unknown): OpenCodeQuestionInfo | null {
    const record = this.getRecord(value)
    if (!record) return null
    const question = typeof record.question === 'string' ? record.question : ''
    const header = typeof record.header === 'string' ? record.header : 'Question'
    const options = Array.isArray(record.options)
      ? record.options.map((option) => {
          const optionRecord = this.getRecord(option)
          if (!optionRecord || typeof optionRecord.label !== 'string') return null
          return {
            label: optionRecord.label,
            ...(typeof optionRecord.description === 'string' ? { description: optionRecord.description } : {}),
          }
        }).filter((option): option is OpenCodeQuestionInfo['options'][number] => Boolean(option))
      : []

    if (!question && !header && options.length === 0) return null
    return {
      question,
      header,
      options,
      ...(typeof record.multiple === 'boolean' ? { multiple: record.multiple } : {}),
      ...(typeof record.custom === 'boolean' ? { custom: record.custom } : {}),
    }
  }

  private mapTodos(value: unknown): OpenCodeTodo[] {
    if (!Array.isArray(value)) return []
    return value
      .map((todo) => {
        const record = this.getRecord(todo)
        if (!record || typeof record.content !== 'string') return null
        return {
          content: record.content,
          status: typeof record.status === 'string' ? record.status : 'pending',
          priority: typeof record.priority === 'string' ? record.priority : 'medium',
        }
      })
      .filter((todo): todo is OpenCodeTodo => Boolean(todo))
  }

  private mapDebugEvent(event: RawEvent, sessionId: string, severity: 'debug' | 'error' = 'debug'): StreamEvent {
    const props = event.properties ?? {}
    return {
      type: 'debug_event',
      sessionId,
      eventName: event.type,
      summary: this.summarizeDebugEvent(event.type, props),
      details: props,
      severity,
    }
  }

  private summarizeDebugEvent(eventName: string, props: Record<string, unknown>): string {
    switch (eventName) {
      case 'session.compacted':
        return 'OpenCode session compacted.'
      case 'session.created':
        return `OpenCode session created${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'session.updated':
        return `OpenCode session updated${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'session.deleted':
        return `OpenCode session deleted${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'workspace.ready':
        return `Workspace ready${typeof props.name === 'string' ? `: ${props.name}` : ''}.`
      case 'workspace.failed':
        return `Workspace failed: ${typeof props.message === 'string' ? props.message : 'unknown failure'}`
      case 'workspace.restore':
        return `Workspace restore ${typeof props.step === 'number' && typeof props.total === 'number' ? `${props.step}/${props.total}` : 'started'}.`
      case 'workspace.status':
        return `Workspace status: ${typeof props.status === 'string' ? props.status : 'unknown'}.`
      case 'server.connected':
        return 'OpenCode server connected.'
      case 'server.instance.disposed':
        return `OpenCode server instance disposed${typeof props.directory === 'string' ? `: ${props.directory}` : ''}.`
      case 'global.disposed':
        return 'OpenCode global disposed.'
      case 'command.executed':
        return `Command executed: ${typeof props.name === 'string' ? props.name : 'unknown'}${typeof props.arguments === 'string' && props.arguments ? ` ${this.truncateInline(props.arguments, 180)}` : ''}.`
      case 'vcs.branch.updated':
        return `VCS branch updated${typeof props.branch === 'string' ? `: ${props.branch}` : ''}.`
      default:
        return `OpenCode event: ${eventName}.`
    }
  }

  private isSessionAgnosticDebugEvent(eventName: string): boolean {
    return eventName === 'workspace.ready'
      || eventName === 'workspace.failed'
      || eventName === 'workspace.status'
      || eventName === 'server.connected'
      || eventName === 'server.instance.disposed'
      || eventName === 'global.disposed'
      || eventName === 'vcs.branch.updated'
      || eventName === 'file.edited'
  }

  private pruneRecentDirectoryEventKeys() {
    const now = Date.now()
    for (const [key, seenAt] of this.recentDirectoryEventKeys.entries()) {
      if (now - seenAt > 2_000) this.recentDirectoryEventKeys.delete(key)
    }
  }

  private safeStableStringify(value: unknown): string {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private truncateInline(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized
  }

  private describeError(error: unknown): string {
    if (!error) return 'Unknown OpenCode error'
    if (typeof error === 'string') return error
    if (typeof error === 'object') {
      const record = error as Record<string, unknown>
      if (typeof record.message === 'string') return record.message
      const data = this.getRecord(record.data)
      if (typeof data?.message === 'string') return data.message
      try {
        return JSON.stringify(error)
      } catch {
        return String(error)
      }
    }
    return String(error)
  }

  private isSessionNotFoundError(error: unknown): boolean {
    const record = this.getRecord(error)
    const response = this.getRecord(record?.response)
    const data = this.getRecord(record?.data)
    const body = this.getRecord(response?.body) ?? this.getRecord(response?.data)
    const status = [
      record?.status,
      record?.statusCode,
      response?.status,
      response?.statusCode,
      data?.status,
      data?.statusCode,
      body?.status,
      body?.statusCode,
    ].find((value) => typeof value === 'number')

    if (status === 404) return true

    const message = [
      typeof record?.message === 'string' ? record.message : '',
      typeof data?.message === 'string' ? data.message : '',
      typeof body?.message === 'string' ? body.message : '',
      typeof body?.error === 'string' ? body.error : '',
    ].join('\n').toLowerCase()

    return /\b404\b/.test(message) || /\bsession\b.*\bnot found\b/.test(message)
  }

  private extractConnectedModelIds(data: unknown): string[] {
    const record = this.getRecord(data)
    const providers = Array.isArray(record?.providers) ? record.providers : []
    const modelIds: string[] = []

    for (const provider of providers) {
      const providerRecord = this.getRecord(provider)
      const providerId = typeof providerRecord?.id === 'string' ? providerRecord.id : undefined
      const models = this.getRecord(providerRecord?.models)
      if (!providerId || !models) continue
      for (const modelId of Object.keys(models)) {
        modelIds.push(`${providerId}/${modelId}`)
      }
    }

    return modelIds.slice(0, MAX_CATALOG_MODEL_IDS)
  }

  private getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  }
}

export { MockOpenCodeAdapter } from './mockAdapter'
