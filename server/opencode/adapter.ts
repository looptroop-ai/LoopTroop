import type {
  HealthStatus,
  Message,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  PromptPart,
  PromptSessionOptions,
  SessionErrorStreamEvent,
  Session,
  StreamEvent,
} from './types'
import type {
  OpenCodeEventSubscription,
  OpenCodePromptRequest,
  OpenCodeTransport,
  OpenCodeTransportEvent,
  OpenCodeTransportEventEnvelope,
  OpenCodeSessionLog,
  PromptDispatch,
} from './transport'
import { OpenCodeV1Transport, type OpenCodeV1Client } from './v1Transport'
import { parseModelRef } from './types'
import { isPermissionDeniedByRules } from './toolPolicy'
import type { TicketState } from './contextBuilder'
import { resolve } from 'path'
import { relative } from 'path'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { readFileNoFollowSync } from '../io/readFile'
import { pathToFileURL } from 'url'
import { logIfVerbose, warnIfVerbose } from '../runtime'
import { getOpenCodeBaseUrl } from './runtimeConfig'
import type { Bead } from '../phases/beads/types'
import { readBeadsFile } from '../phases/beads/beadsFile'
import { parseExecutionSetupPlanNotes } from '../phases/executionSetupPlan/types'
import { parseExecutionSetupRetryNotes } from '../phases/executionSetup/types'
import { renderCommandSpec } from '@shared/commandSpec'
import { looksLikePromptEcho } from '../lib/promptEcho'
import {
  ADAPTER_RETRY_DELAY_MS,
  SDK_OPERATION_TIMEOUT_MS,
} from '../lib/constants'
import { analyzeAssistantMessages } from './assistantMessageAnalysis'
import { summarizeModelErrorForLog } from './errorDetails'
import { enrichGenericOpenCodeProviderError } from './logDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'
import { isAbortError } from '../lib/abort'
import { OpenCodeConnectionError } from './connection'

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
  listPendingQuestions(projectPath?: string, signal?: AbortSignal, sessionId?: string): Promise<OpenCodeQuestionRequest[]>
  replyQuestion(
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    projectPath?: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<void>
  rejectQuestion(requestId: string, projectPath?: string, signal?: AbortSignal, sessionId?: string): Promise<void>
  abortSession(sessionId: string): Promise<boolean>
  /** Drops local directory state after the owning DB row reaches a terminal state. */
  forgetSessionDirectory?(sessionId: string): void
  assembleBeadContext(ticketId: string, beadId: string): Promise<PromptPart[]>
  assembleCouncilContext(ticketId: string, phase: string): Promise<PromptPart[]>
  /**
   * Pass the ticket's signal even when racing the returned promise: racing
   * abandons the wait, the signal abandons the request. Without it a cancelled
   * ticket left probes running against an unreachable server for their whole
   * timeout.
   */
  checkHealth(signal?: AbortSignal): Promise<HealthStatus>
}

export type OpenCodeTransportResolver = (
  baseUrl: string,
  signal?: AbortSignal,
) => Promise<OpenCodeTransport>

type AcceptedPromptTerminal = Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }>
type AcceptedPromptLifecycleResult =
  | { kind: 'complete'; terminal: AcceptedPromptTerminal }
  | { kind: 'conflict'; error: string }

function hasCompleteV2LogCoverage(after: number, log: OpenCodeSessionLog): boolean {
  if (log.coverageComplete === false || !Number.isSafeInteger(log.cursor) || log.cursor! < after) return false
  let next = after + 1
  for (const envelope of log.events) {
    if (!Number.isSafeInteger(envelope.cursor) || envelope.cursor !== next) return false
    next++
  }
  return next === log.cursor! + 1
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
  private readonly baseUrl: string
  private readonly injectedV1Client?: OpenCodeV1Client
  private readonly transportResolver?: OpenCodeTransportResolver
  private transport?: OpenCodeTransport
  private transportInitialization?: Promise<OpenCodeTransport>
  private transportGeneration = 0
  private sessionDirectories = new Map<string, string>()
  private questionDirectories = new Map<string, string>()
  private questionSessions = new Map<string, string>()
  private activePromptSessions = new Set<string>()

  constructor(
    baseUrlOrPort: string | number = getOpenCodeBaseUrl(),
    client?: OpenCodeV1Client,
    transportResolver?: OpenCodeTransportResolver,
  ) {
    this.baseUrl = typeof baseUrlOrPort === 'number'
      ? `http://localhost:${baseUrlOrPort}`
      : baseUrlOrPort
    this.injectedV1Client = client
    this.transportResolver = transportResolver
  }

  private async getTransport(signal?: AbortSignal): Promise<OpenCodeTransport> {
    if (this.transport) return this.transport
    if (!this.transportInitialization) {
      const generation = this.transportGeneration
      const initialization = this.createTransport(signal)
      this.transportInitialization = initialization
      try {
        const transport = await initialization
        if (generation === this.transportGeneration && this.transportInitialization === initialization) {
          this.transport = transport
        }
        return transport
      } catch (error) {
        if (this.transportInitialization === initialization) this.transportInitialization = undefined
        throw error
      }
    }
    return await this.transportInitialization
  }

  /** Re-resolve the protocol for future calls after an owned server restart. */
  resetTransportForFutureOperations(): void {
    this.transportGeneration += 1
    this.transport = undefined
    this.transportInitialization = undefined
  }

  private async createTransport(signal?: AbortSignal): Promise<OpenCodeTransport> {
    if (this.injectedV1Client) return new OpenCodeV1Transport(this.baseUrl, this.injectedV1Client)
    if (this.transportResolver) return this.transportResolver(this.baseUrl, signal)
    const { getOpenCodeConnection } = await import('./connection')
    const connection = await getOpenCodeConnection(this.baseUrl, signal)
    if (connection.protocol === 'v2') {
      const { V2OpenCodeTransport } = await import('./v2Transport')
      return new V2OpenCodeTransport(this.baseUrl, { headers: connection.headers })
    }
    return new OpenCodeV1Transport(this.baseUrl, undefined, connection.headers)
  }

  async createSession(
    projectPath: string,
    signal?: AbortSignal,
    options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    try {
      const session = await (await this.getTransport(signal)).createSession(projectPath, options, signal)
      this.sessionDirectories.set(session.id, session.directory ?? session.projectPath ?? projectPath)
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
    if (this.activePromptSessions.has(sessionId)) {
      throw new Error(`OpenCode session ${sessionId} already has a prompt in progress`)
    }
    this.activePromptSessions.add(sessionId)
    const promptSignal = options?.signal ?? signal
    // SDK_OPERATION_TIMEOUT_MS bounds individual API calls, not a whole model
    // generation. The caller owns the workflow deadline for this prompt.
    const operationSignal = promptSignal
    const promptOptions = { ...options, signal: operationSignal }
    const model = promptOptions.model ?? parseModelRef(promptOptions.modelRef)
    const streamAbortController = new AbortController()
    const dispatchAbortController = new AbortController()
    const streamSignal = operationSignal
      ? AbortSignal.any([operationSignal, streamAbortController.signal])
      : streamAbortController.signal
    const dispatchSignal = operationSignal
      ? AbortSignal.any([operationSignal, dispatchAbortController.signal])
      : dispatchAbortController.signal
    let streamDrain: Promise<{ ended: boolean; error?: unknown }> | undefined
    let permissionReplyFailure: Error | null = null
    let permissionReplyPending: Promise<void> | undefined

    try {
      const transport = await this.getTransport(operationSignal)
      const directory = await this.resolveSessionDirectory(sessionId, operationSignal, transport)
      await transport.waitForIdle(sessionId, directory, operationSignal)
      if (promptOptions.permission) {
        try {
          await transport.updateSession(sessionId, directory, { permission: promptOptions.permission }, operationSignal)
        } catch (error) {
          if (isAbortError(error) || operationSignal?.aborted) throw error
          throw new Error(
            `Failed to apply OpenCode session permissions: ${getErrorMessage(error)}. ` +
            'Session permission updates require a current OpenCode server; upgrade OpenCode and restart `opencode serve`.',
          )
        }
      }

      const subscription = await transport.subscribeToEvents(
        sessionId,
        directory,
        streamSignal,
        promptOptions.stepFinishSafetyMs,
      )
      const baselineMessages = transport.protocol === 'v2'
        ? await transport.getSessionMessages(sessionId, directory, operationSignal)
        : []
      const baselineMessageIds = new Set(baselineMessages.map(message => message.id).filter(Boolean))
      const snapshotBaselineIds = transport.protocol === 'v2' ? baselineMessageIds : undefined
      let lastCursor = subscription.cursor
      const streamedTextByMessage = new Map<string, Map<string, string>>()
      const streamedTextMessageOrder: string[] = []
      const streamedTextPartIndex = new Map<string, string>()
      let latestSessionErrorEvent: SessionErrorStreamEvent | undefined
      const rememberStreamText = (event: StreamEvent) => {
        if (event.type === 'session_error') {
          latestSessionErrorEvent = event
          return
        }
        if (event.type === 'text') {
          const messageId = event.messageId ?? '__stream__'
          if (transport.protocol === 'v2' && baselineMessageIds.has(messageId)) return
          const partId = event.partId ?? `${messageId}:text`
          let messageParts = streamedTextByMessage.get(messageId)
          if (!messageParts) {
            messageParts = new Map<string, string>()
            streamedTextByMessage.set(messageId, messageParts)
            streamedTextMessageOrder.push(messageId)
          }
          messageParts.set(partId, event.text)
          streamedTextPartIndex.set(partId, messageId)
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
        }
      }
      const buildStreamedTextResponse = (): string => {
        const messageId = streamedTextMessageOrder[streamedTextMessageOrder.length - 1]
        if (!messageId) return ''
        const messageParts = streamedTextByMessage.get(messageId)
        return messageParts ? Array.from(messageParts.values()).join('').trim() : ''
      }
      let streamDoneObserved = false
      let resolveStreamDoneResponse: ((value: string | null) => void) | undefined
      const streamDoneResponse = new Promise<string | null>(resolve => { resolveStreamDoneResponse = resolve })

      const lifecycle = {
        enqueued: new Set<string>(),
        delivered: new Set<string>(),
        started: false,
        terminal: undefined as Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }> | undefined,
        receiptID: undefined as string | undefined,
        failure: undefined as string | undefined,
        resolve: undefined as ((value: { kind: 'complete'; terminal: Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }> } | { kind: 'conflict'; error: string }) => void) | undefined,
        settled: false,
      }
      const lifecycleResult = new Promise<
        | { kind: 'complete'; terminal: Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }> }
        | { kind: 'conflict'; error: string }
      >(resolve => { lifecycle.resolve = resolve })
      const finishLifecycle = (result: { kind: 'complete'; terminal: Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }> } | { kind: 'conflict'; error: string }) => {
        if (lifecycle.settled) return
        lifecycle.settled = true
        lifecycle.resolve?.(result)
      }
      const checkLifecycle = () => {
        if (lifecycle.receiptID) {
          const otherInboxes = new Set([...lifecycle.enqueued, ...lifecycle.delivered].filter(id => id !== lifecycle.receiptID))
          if (otherInboxes.size > 0) {
            lifecycle.failure = 'Another prompt entered the OpenCode session during result attribution; the response cannot be attributed safely.'
            finishLifecycle({ kind: 'conflict', error: lifecycle.failure })
            return
          }
          if (lifecycle.delivered.has(lifecycle.receiptID) && lifecycle.started && lifecycle.terminal) {
            finishLifecycle({ kind: 'complete', terminal: lifecycle.terminal })
          }
        }
      }
      const handledPermissionIds = new Set<string>()
      const observeEnvelope = async (envelope: OpenCodeTransportEventEnvelope) => {
        if (transport.protocol === 'v2' && envelope.coverageGap) {
          lifecycle.failure = 'OpenCode v2 event history has an unaccounted durable sequence gap; the response cannot be attributed safely.'
          finishLifecycle({ kind: 'conflict', error: lifecycle.failure })
          return
        }
        if (typeof envelope.cursor === 'number' && (lastCursor === undefined || envelope.cursor > lastCursor)) {
          lastCursor = envelope.cursor
        }
        const event = envelope.event
        if (event.type === 'inbox_enqueued') lifecycle.enqueued.add(event.inboxID)
        else if (event.type === 'inbox_delivered') lifecycle.delivered.add(event.inboxID)
        else if (event.type === 'execution_started') lifecycle.started = true
        else if (event.type === 'execution_terminal') lifecycle.terminal = event
        else {
          const streamEvent = event as StreamEvent
          rememberStreamText(streamEvent)
          promptOptions.onEvent?.(streamEvent)
          if (transport.protocol === 'v1' && streamEvent.type === 'done' && !streamDoneObserved) {
            streamDoneObserved = true
            void this.readAssistantSnapshotWithRetry(sessionId, undefined, 4, 75, operationSignal, snapshotBaselineIds, directory, transport)
              .then(snapshot => resolveStreamDoneResponse?.(snapshot.responseText || buildStreamedTextResponse() || null))
              .catch(error => {
                if (isAbortError(error)) {
                  resolveStreamDoneResponse?.(null)
                  return
                }
                warnIfVerbose('[adapter] Snapshot retry failed after stream done, falling back to streamed text', error)
                resolveStreamDoneResponse?.(buildStreamedTextResponse() || null)
              })
          }
          if (
            streamEvent.type === 'permission'
            && streamEvent.action === 'asked'
            && promptOptions.autoApprovePermissions
            && streamEvent.permissionId
            && !handledPermissionIds.has(streamEvent.permissionId)
          ) {
            handledPermissionIds.add(streamEvent.permissionId)
            const deniedByPolicy = isPermissionDeniedByRules(promptOptions.permission, streamEvent.permission)
            permissionReplyPending = transport.replyPermission(
                sessionId,
                streamEvent.permissionId,
                deniedByPolicy ? 'reject' : 'always',
                directory,
                operationSignal,
              ).catch(async (error) => {
              permissionReplyFailure = new Error(
                `Failed to ${deniedByPolicy ? 'reject' : 'auto-approve'} OpenCode permission ${streamEvent.permission ?? streamEvent.permissionId}: ${getErrorMessage(error)}`,
              )
              dispatchAbortController.abort()
              await transport.interruptSession(sessionId, directory).catch(() => false)
              throw permissionReplyFailure
              })
            await permissionReplyPending
          }
        }
        checkLifecycle()
      }

      const reconcileAcceptedPromptAfterSnapshot = async () => {
        if (transport.protocol !== 'v2' || !lifecycle.receiptID) return
        if (lifecycle.failure) throw new Error(lifecycle.failure)
        const cursor = lastCursor
        if (cursor === undefined) {
          throw new Error('OpenCode accepted the prompt, but its snapshot could not be certified without a durable event cursor')
        }

        let log
        try {
          log = await transport.readSessionLog(sessionId, cursor, operationSignal)
        } catch (error) {
          if (operationSignal?.aborted || isAbortError(error)) throw error
          throw new Error(`OpenCode accepted the prompt, but durable event certification failed: ${getErrorMessage(error)}`)
        }
        if (!hasCompleteV2LogCoverage(cursor, log)) {
          throw new Error('OpenCode accepted the prompt, but durable event history has an unaccounted sequence gap and cannot certify the snapshot')
        }
        for (const envelope of log.events) await observeEnvelope(envelope)
        if (typeof log.cursor === 'number' && (lastCursor === undefined || log.cursor > lastCursor)) {
          lastCursor = log.cursor
        }
        if (lifecycle.failure) throw new Error(lifecycle.failure)
      }

      streamDrain = this.consumeTransportEvents(
        subscription,
        observeEnvelope,
        streamSignal,
        transport.protocol === 'v1',
      )

      const dispatchRequest: OpenCodePromptRequest = {
        sessionId,
        directory,
        parts,
        ...(model ? { model } : {}),
        ...(promptOptions.agent ? { agent: promptOptions.agent } : {}),
        ...(promptOptions.variant ? { variant: promptOptions.variant } : {}),
        ...(promptOptions.system ? { system: promptOptions.system } : {}),
        ...(typeof promptOptions.noReply === 'boolean' ? { noReply: promptOptions.noReply } : {}),
        ...('tools' in promptOptions && promptOptions.tools ? { tools: promptOptions.tools as Record<string, boolean> } : {}),
      }
      const dispatchPromise = transport.dispatchPrompt(dispatchRequest, dispatchSignal)
      let dispatched: PromptDispatch | undefined
      let responseText = ''
      if (transport.protocol === 'v1') {
        const firstResult = await Promise.race([
          this.raceWithSignal(dispatchPromise, dispatchSignal)
            .then(value => ({ kind: 'dispatched' as const, value })),
          streamDoneResponse.then(value => ({ kind: 'stream' as const, value })),
        ])
        if (firstResult.kind === 'stream' && firstResult.value) {
          responseText = firstResult.value
          dispatchAbortController.abort()
          void dispatchPromise.catch(() => undefined)
        } else if (firstResult.kind === 'dispatched') {
          dispatched = firstResult.value
        } else {
          dispatched = await this.raceWithSignal(dispatchPromise, dispatchSignal)
        }
      } else {
        dispatched = await this.raceWithSignal(dispatchPromise, dispatchSignal)
      }
      if (permissionReplyPending) await permissionReplyPending
      if (permissionReplyFailure) throw permissionReplyFailure
      if (dispatched?.kind === 'accepted') {
        if (promptOptions.noReply === true) return ''
        lifecycle.receiptID = dispatched.receipt.inboxID
        checkLifecycle()
        const terminal = await this.waitForAcceptedPrompt(
          transport,
          sessionId,
          dispatched,
          lifecycleResult,
          streamDrain,
          observeEnvelope,
          () => lastCursor,
          operationSignal,
        )
        if (terminal.outcome === 'interrupted') {
          const error = new Error('OpenCode interrupted the accepted prompt before it completed')
          error.name = 'OpenCodeSessionInterrupted'
          throw error
        }
        if (terminal.outcome === 'failed') {
          const summary = summarizeModelErrorForLog(terminal.error, getErrorMessage(terminal.error))
          const error = new Error(summary.message || 'OpenCode execution failed')
          Object.assign(error, { details: terminal.error, sessionError: terminal.error, modelErrorDetails: summary.details })
          error.name = 'OpenCodeSessionError'
          throw error
        }
        const snapshot = await this.readAssistantSnapshotWithRetry(sessionId, undefined, 4, 75, operationSignal, snapshotBaselineIds, directory, transport)
        // Reconcile durable events after the snapshot too: a dropped SSE stream
        // can hide another inbox while the newest assistant message changes.
        await reconcileAcceptedPromptAfterSnapshot()
        if (snapshot.responseMeta.latestAssistantWasStale) {
          throw new Error('OpenCode completed the accepted prompt but the newest assistant snapshot is stale')
        }
        if (snapshot.responseMeta.latestAssistantHasError) {
          const error = new Error(snapshot.responseMeta.latestAssistantError ?? 'OpenCode assistant response failed')
          Object.assign(error, { details: snapshot.responseMeta.latestAssistantErrorInfo })
          error.name = 'OpenCodeSessionError'
          throw error
        }
        responseText = snapshot.responseText
      } else if (dispatched) {
        const completedMessage = dispatched.message
        if (!completedMessage.id || !baselineMessageIds.has(completedMessage.id)) {
          responseText = completedMessage.content?.trim() ?? ''
        }
        if (!responseText) {
          try {
            const snapshot = await this.readAssistantSnapshotWithRetry(
              sessionId,
              completedMessage.id || undefined,
              4,
              75,
              operationSignal,
              snapshotBaselineIds,
              directory,
              transport,
            )
            responseText = snapshot.responseText
          } catch (error) {
            if (isAbortError(error)) throw error
            warnIfVerbose('[adapter] Snapshot read failed after prompt, falling back to streamed text', error)
            responseText = buildStreamedTextResponse()
          }
        }
        if (!responseText) responseText = buildStreamedTextResponse()
      }

      if (!responseText && latestSessionErrorEvent) {
        const summary = summarizeModelErrorForLog(latestSessionErrorEvent.details ?? latestSessionErrorEvent.error, latestSessionErrorEvent.error)
        const error = new Error(summary.message)
        Object.assign(error, {
          details: latestSessionErrorEvent.details,
          sessionError: latestSessionErrorEvent.error,
          modelErrorDetails: summary.details,
        })
        error.name = 'OpenCodeSessionError'
        throw error
      }
      if (responseText && looksLikePromptEcho(responseText)) {
        if (transport.protocol === 'v1' && !streamDoneObserved) {
          const streamClose = await this.raceWithSignal(
            Promise.race([
              streamDoneResponse.then(value => ({ kind: 'done' as const, value })),
              streamDrain.then(() => ({ kind: 'closed' as const })),
            ]),
            operationSignal,
          )
          const terminalText = streamClose.kind === 'done'
            ? streamClose.value
            : streamDoneObserved
              ? await this.raceWithSignal(streamDoneResponse, operationSignal)
              : await this.readAssistantSnapshotWithRetry(sessionId, undefined, 2, 75, operationSignal, snapshotBaselineIds, directory, transport)
                .then(snapshot => snapshot.responseText || buildStreamedTextResponse() || null)
          if (terminalText) responseText = terminalText
        } else {
          const snapshot = await this.readAssistantSnapshotWithRetry(sessionId, undefined, 2, 75, operationSignal, snapshotBaselineIds, directory, transport)
          await reconcileAcceptedPromptAfterSnapshot()
          if (snapshot.responseText) responseText = snapshot.responseText
        }
      }
      if (!responseText) warnIfVerbose(`[adapter] promptSession: OpenCode returned empty response for session=${sessionId}`)
      return responseText
    } catch (err) {
      if (permissionReplyFailure) throw permissionReplyFailure
      if (isAbortError(err) || promptSignal?.aborted) throw err
      if (operationSignal?.aborted && operationSignal.reason instanceof Error) throw operationSignal.reason
      if (err instanceof Error && (err.name === 'OpenCodeSessionError' || err.name === 'OpenCodeSessionInterrupted')) throw err
      const enriched = enrichGenericOpenCodeProviderError(err, sessionId)
      if (enriched) {
        const error = new Error(`Failed to prompt OpenCode session: ${enriched.message}`)
        Object.assign(error, { details: enriched.details, modelErrorDetails: enriched.details })
        throw error
      }
      throw new Error(`Failed to prompt OpenCode session: ${getErrorMessage(err)}`)
    } finally {
      streamAbortController.abort()
      await this.waitForStreamDrain(streamDrain)
      this.activePromptSessions.delete(sessionId)
    }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    return await (await this.getTransport(signal)).listSessions(signal)
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    return await this.getSessionWithTransport(sessionId, signal, await this.getTransport(signal))
  }

  private async getSessionWithTransport(
    sessionId: string,
    signal: AbortSignal | undefined,
    transport: OpenCodeTransport,
  ): Promise<Session | null> {
    try {
      const session = await transport.getSession(sessionId, signal)
      if (session && session.directory) this.sessionDirectories.set(session.id, session.directory)
      return session
    } catch (err) {
      if (isAbortError(err)) throw err
      // A textual "404" or "session not found" is not enough to prove that
      // the remote session is gone. SDK transport errors often preserve the
      // server's message while losing its HTTP status; only the exact status
      // is safe to treat as an already-stopped session.
      if (this.isConfirmedSessionNotFoundError(err)) return null
      throw err
    }
  }

  async getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<Message[]> {
    const transport = await this.getTransport(signal)
    const directory = await this.resolveSessionDirectory(sessionId, signal, transport)
    return await this.getSessionMessagesWithTransport(sessionId, directory, signal, transport)
  }

  private async getSessionMessagesWithTransport(
    sessionId: string,
    directory: string | undefined,
    signal: AbortSignal | undefined,
    transport: OpenCodeTransport,
  ): Promise<Message[]> {
    try {
      return await transport.getSessionMessages(sessionId, directory, signal)
    } catch (err) {
      // `[]` has to mean "the list succeeded and was empty". Swallowing a
      // cancellation or a 5xx here made a failed read look like a completed
      // turn with no output, and `readAssistantSnapshotWithRetry` then retried
      // three more times and returned an empty snapshot as if it were real.
      if (signal?.aborted || isAbortError(err)) throw err
      warnIfVerbose(`[adapter] getSessionMessages failed for session=${sessionId}`, err)
      throw err
    }
  }

  async listPendingQuestions(projectPath?: string, signal?: AbortSignal, sessionId?: string): Promise<OpenCodeQuestionRequest[]> {
    const transport = await this.getTransport(signal)
    const directory = sessionId
      ? await this.requireSessionDirectory(sessionId, signal, transport)
      : projectPath
    const requests = await transport.listPendingQuestions(projectPath, sessionId, directory, signal)
    for (const request of requests) {
      this.questionSessions.set(request.id, request.sessionID)
      if (sessionId && directory) this.questionDirectories.set(request.id, directory)
    }
    return requests
  }

  async replyQuestion(
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    _projectPath?: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<void> {
    const transport = await this.getTransport(signal)
    const directory = await this.resolveQuestionDirectory(requestId, sessionId, signal, transport)
    const ownerSessionId = sessionId ?? this.questionSessions.get(requestId)
    if (!ownerSessionId) throw new Error(`OpenCode question ${requestId} has no trusted session owner`)
    await transport.replyQuestion(ownerSessionId, requestId, answers, directory, signal)
    this.forgetQuestion(requestId)
  }

  async rejectQuestion(requestId: string, _projectPath?: string, signal?: AbortSignal, sessionId?: string): Promise<void> {
    const transport = await this.getTransport(signal)
    const directory = await this.resolveQuestionDirectory(requestId, sessionId, signal, transport)
    const ownerSessionId = sessionId ?? this.questionSessions.get(requestId)
    if (!ownerSessionId) throw new Error(`OpenCode question ${requestId} has no trusted session owner`)
    await transport.rejectQuestion(ownerSessionId, requestId, directory, signal)
    this.forgetQuestion(requestId)
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      const transport = await this.getTransport()
      // A session may have been removed by OpenCode between the prompt and
      // cleanup. A confirmed 404 is already the desired terminal state; an
      // unavailable lookup, an untrusted directory, or any other failure is
      // not evidence that the remote session stopped.
      let directory = this.sessionDirectories.get(sessionId)
      if (!directory) {
        const session = await this.getSessionWithTransport(sessionId, undefined, transport)
        if (!session) {
          this.forgetSessionDirectory(sessionId)
          return true
        }
        directory = session.directory
        if (!directory) return false
      }
      const stopped = await transport.interruptSession(
        sessionId,
        directory,
      )
      if (stopped) this.forgetSessionDirectory(sessionId)
      return stopped
    } catch (error) {
      if (this.isConfirmedSessionNotFoundError(error)) {
        this.forgetSessionDirectory(sessionId)
        return true
      }
      return false
    }
  }

  forgetSessionDirectory(sessionId: string): void {
    this.sessionDirectories.delete(sessionId)
    for (const [requestId, ownerSessionId] of this.questionSessions) {
      if (ownerSessionId === sessionId) this.forgetQuestion(requestId)
    }
  }

  async *subscribeToEvents(sessionId: string, signal?: AbortSignal, stepFinishSafetyMs?: number): AsyncGenerator<StreamEvent> {
    const transport = await this.getTransport(signal)
    const directory = await this.resolveSessionDirectory(sessionId, signal, transport)
    const subscription = await transport.subscribeToEvents(
      sessionId,
      directory,
      signal,
      stepFinishSafetyMs,
    )
    for await (const envelope of subscription.events) {
      const event = envelope.event
      if (this.isTransportLifecycleEvent(event)) continue
      yield event
      if (event.type === 'done') return
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
    const { getLatestPhaseArtifact, getTicketContext, getTicketPaths, readTicketFile } = await import('../storage/tickets')

    const state: TicketState = { ticketId }

    const ticket = getTicketContext(ticketId)
    if (ticket) {
      state.projectId = ticket.projectId
      // Keep one composite key in contextBuilder even when a caller reached
      // this adapter with an external id alias.
      state.ticketId = ticket.ticketRef
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
      try {
        state[field] = readTicketFile(ticketId, file) ?? undefined
      } catch (err) {
        if (err instanceof ContainedPathError) throw err
        warnIfVerbose(`[adapter] Failed to read ${file}:`, err)
      }
    }

    const beadsPath = paths.beadsPath
    const executionSetupPlanArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')
    if (executionSetupPlanArtifact?.content) {
      state.executionSetupPlan = executionSetupPlanArtifact.content
    }

    const executionSetupPlanNotesArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_plan_notes', 'WAITING_EXECUTION_SETUP_APPROVAL')
    state.executionSetupPlanNotes = parseExecutionSetupPlanNotes(executionSetupPlanNotesArtifact?.content)

    try {
      state.executionSetupProfile = readTicketFile(ticketId, 'runtime/execution-setup-profile.json') ?? undefined
    } catch (err) {
      if (err instanceof ContainedPathError) throw err
      warnIfVerbose('[adapter] Failed to read execution setup profile:', err)
    }

    const executionSetupNotesArtifact = getLatestPhaseArtifact(ticketId, 'execution_setup_retry_notes', 'PREPARING_EXECUTION_ENV')
    state.executionSetupNotes = parseExecutionSetupRetryNotes(executionSetupNotesArtifact?.content)

    try {
      const containedBeadsPath = resolveContainedPath(ticketDir, beadsPath)
      const beadFile = readFileNoFollowSync(containedBeadsPath)
      state.beads = beadFile

      if (beadId) {
        // The raw file text above is what the prompt shows; the bead itself is
        // read through the reconciler, so a legacy stored status does not reach
        // `formatBeadContext` unrecognised and a malformed line does not abort
        // the whole read.
        const bead = readBeadsFile(containedBeadsPath, { malformedEntries: 'skip' }).find((entry) => entry.id === beadId)

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
      if (err instanceof ContainedPathError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnIfVerbose(`[adapter] Failed to read beads.jsonl:`, err)
      }
    }

    return state
  }

  async checkHealth(signal?: AbortSignal): Promise<HealthStatus> {
    const timeoutSignal = AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      return await (await this.getTransport(operationSignal)).checkHealth(operationSignal)
    } catch (err) {
      if (err instanceof OpenCodeConnectionError) {
        return {
          available: false,
          failureKind: err.failureKind,
          error: err.message,
        }
      }
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }
    }
  }

  private async loadQaEvidenceFileParts(ticketId: string, beadId: string): Promise<PromptPart[]> {
    const { getTicketPaths } = await import('../storage/tickets')
    const { getManualQaStoragePaths, resolveContainedEvidencePath } = await import('../phases/manualQa/storage')
    const paths = getTicketPaths(ticketId)
    if (!paths) return []
    let bead: Bead | undefined
    try {
      // Authoritative read: this manifest decides which evidence images the
      // prompt carries, so a dropped line has to be an error rather than an
      // image that quietly does not arrive.
      bead = readBeadsFile(resolveContainedPath(paths.ticketDir, paths.beadsPath, { allowMissingParents: true }), { malformedEntries: 'fail' })
        .find((entry) => entry.id === beadId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`Failed to load Manual QA evidence manifest for bead ${beadId}: ${getErrorMessage(error)}`)
    }
    if (!bead?.qaOrigin || bead.qaOrigin.imageDelivery !== 'attached') return []
    return bead.qaOrigin.sourceItems.flatMap((item) => item.evidence.flatMap((evidence) => {
      if (!evidence.mediaType.toLowerCase().startsWith('image/')) return []
      let localPath: string
      try {
        const evidencePaths = getManualQaStoragePaths(paths.ticketDir, bead.qaOrigin!.version)
        localPath = resolveContainedPath(paths.ticketDir, resolveContainedEvidencePath(
          evidencePaths.root,
          evidencePaths.evidenceDir,
          relative(evidencePaths.evidenceDir, resolve(paths.ticketDir, evidence.relativePath)),
        ))
      } catch {
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
    signal?: AbortSignal,
    baselineMessageIds?: ReadonlySet<string>,
    directory?: string,
    transport?: OpenCodeTransport,
  ): Promise<ReturnType<typeof analyzeAssistantMessages>> {
    // A read that fails is retried like an empty one, but if every attempt
    // fails the failure is surfaced rather than reported as a completed turn
    // with no output.
    let lastReadError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError')
      }
      let messages: Message[]
      try {
        messages = transport
          ? await this.getSessionMessagesWithTransport(sessionId, directory, signal, transport)
          : await this.getSessionMessages(sessionId, signal)
        lastReadError = null
      } catch (err) {
        if (isAbortError(err)) throw err
        lastReadError = err
        if (attempt >= maxAttempts) break
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      const relevantMessages = baselineMessageIds
        ? messages.filter(message => Boolean(message.id) && !baselineMessageIds.has(message.id))
        : messages
      const analysis = analyzeAssistantMessages(relevantMessages, preferredMessageId)
      if (analysis.responseText || analysis.responseMeta.latestAssistantHasError || analysis.responseMeta.latestAssistantWasStale) {
        return analysis
      }
      if (attempt >= maxAttempts) break
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
    if (lastReadError) throw lastReadError

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

  private async resolveSessionDirectory(
    sessionId: string,
    signal?: AbortSignal,
    transport?: OpenCodeTransport,
  ): Promise<string | undefined> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError')
    }
    const cached = this.sessionDirectories.get(sessionId)
    if (cached) return cached

    try {
      const session = transport
        ? await this.getSessionWithTransport(sessionId, signal, transport)
        : await this.getSession(sessionId, signal)
      return session?.directory
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      return undefined
    }
  }

  private async requireSessionDirectory(
    sessionId: string,
    signal?: AbortSignal,
    transport?: OpenCodeTransport,
  ): Promise<string> {
    const directory = await this.resolveSessionDirectory(sessionId, signal, transport)
    if (!directory) throw new Error(`OpenCode session ${sessionId} has no trusted worktree directory`)
    return directory
  }

  private rememberQuestion(requestId: string, sessionId: string, directory?: string): void {
    this.questionSessions.set(requestId, sessionId)
    const trustedDirectory = directory ?? this.sessionDirectories.get(sessionId)
    if (trustedDirectory) this.questionDirectories.set(requestId, trustedDirectory)
  }

  private forgetQuestion(requestId: string): void {
    this.questionSessions.delete(requestId)
    this.questionDirectories.delete(requestId)
  }

  private async resolveQuestionDirectory(
    requestId: string,
    sessionId: string | undefined,
    signal?: AbortSignal,
    transport?: OpenCodeTransport,
  ): Promise<string> {
    if (sessionId) {
      const directory = await this.requireSessionDirectory(sessionId, signal, transport)
      this.rememberQuestion(requestId, sessionId, directory)
      return directory
    }

    const cachedDirectory = this.questionDirectories.get(requestId)
    if (cachedDirectory) return cachedDirectory

    const ownerSessionId = this.questionSessions.get(requestId)
    if (ownerSessionId) {
      const directory = await this.requireSessionDirectory(ownerSessionId, signal, transport)
      this.questionDirectories.set(requestId, directory)
      return directory
    }

    throw new Error(`OpenCode question ${requestId} has no trusted session directory`)
  }

  private isTransportLifecycleEvent(event: OpenCodeTransportEvent): event is Exclude<OpenCodeTransportEvent, StreamEvent> {
    return event.type === 'inbox_enqueued'
      || event.type === 'inbox_delivered'
      || event.type === 'execution_started'
      || event.type === 'execution_terminal'
  }

  private async consumeTransportEvents(
    subscription: OpenCodeEventSubscription,
    onEnvelope: (envelope: OpenCodeTransportEventEnvelope) => void | Promise<void>,
    signal: AbortSignal,
    stopAfterDone: boolean,
  ): Promise<{ ended: boolean; error?: unknown }> {
    try {
      for await (const envelope of subscription.events) {
        if (signal.aborted) return { ended: true }
        await onEnvelope(envelope)
        if (stopAfterDone && envelope.event.type === 'done') break
      }
      return { ended: true }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return { ended: true }
      return { ended: true, error }
    }
  }

  private async waitForAcceptedPrompt(
    transport: OpenCodeTransport,
    sessionId: string,
    _dispatch: Extract<PromptDispatch, { kind: 'accepted' }>,
    lifecycleResult: Promise<AcceptedPromptLifecycleResult>,
    streamDrain: Promise<{ ended: boolean; error?: unknown }>,
    observeEnvelope: (envelope: OpenCodeTransportEventEnvelope) => void | Promise<void>,
    getCursor: () => number | undefined,
    signal?: AbortSignal,
  ): Promise<AcceptedPromptTerminal> {
    const first = await Promise.race([
      lifecycleResult.then(result => ({ kind: 'lifecycle' as const, result })),
      streamDrain.then(result => ({ kind: 'stream' as const, result })),
    ])
    if (first.kind === 'lifecycle') {
      if (first.result.kind === 'conflict') throw new Error(first.result.error)
      return first.result.terminal
    }

    if (first.result.error) {
      warnIfVerbose('[adapter] OpenCode event stream ended; checking the durable session log', first.result.error)
    }
    if (transport.protocol !== 'v2') {
      throw new Error('OpenCode event stream ended before the accepted prompt completed')
    }

    let cursor = getCursor()
    if (cursor === undefined) {
      throw new Error('OpenCode accepted the prompt, but its event subscription had no durable cursor for recovery')
    }
    while (true) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError')
      }
      let log
      try {
        log = await transport.readSessionLog(sessionId, cursor, signal)
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error
        throw new Error(`OpenCode accepted the prompt, but durable event recovery failed: ${getErrorMessage(error)}`)
      }
      if (!hasCompleteV2LogCoverage(cursor, log)) {
        throw new Error('OpenCode accepted the prompt, but durable event history has an unaccounted sequence gap and cannot certify completion')
      }
      for (const envelope of log.events) {
        await observeEnvelope(envelope)
        if (typeof envelope.cursor === 'number' && envelope.cursor > cursor) cursor = envelope.cursor
      }
      if (typeof log.cursor === 'number' && log.cursor > cursor) cursor = log.cursor

      const outcome = await Promise.race([
        lifecycleResult,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 200)),
      ])
      if (outcome) {
        if (outcome.kind === 'conflict') throw new Error(outcome.error)
        return outcome.terminal
      }
    }
  }

  private async waitForStreamDrain(streamDrain: Promise<{ ended: boolean; error?: unknown }> | null | undefined) {
    if (!streamDrain) return
    await Promise.race([
      streamDrain,
      new Promise<void>(resolve => setTimeout(resolve, ADAPTER_RETRY_DELAY_MS)),
    ])
  }

  private async raceWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await operation
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError')
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([operation, aborted])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private isConfirmedSessionNotFoundError(error: unknown): boolean {
    const record = this.getRecord(error)
    const response = this.getRecord(record?.response)
    const status = this.readHttpStatus(response) ?? this.readHttpStatus(record)
    return status === 404
  }

  private readHttpStatus(value: Record<string, unknown> | null | undefined): number | undefined {
    if (typeof value?.status === 'number') return value.status
    if (typeof value?.statusCode === 'number') return value.statusCode
    return undefined
  }

  private getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  }
}

export { MockOpenCodeAdapter } from './mockAdapter'
