import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  ensureActivePhaseAttempt,
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  listPhaseAttempts,
  patchTicket,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { ticketRouter } from '../tickets'
import { contentSha256 } from '../../lib/contentHash'
import { revertTicketToApprovalStatus } from '../../machines/persistence'
import { lockExecutionSetupPlanDetectedHooks } from '../../phases/executionSetupPlan/hookEvidence'
import { saveExecutionSetupPlan } from '../../phases/executionSetupPlan/document'
import { serializeExecutionSetupPlan } from '../../phases/executionSetupPlan/types'

const shellCommand = (script: string) => ({
  mode: 'shell' as const,
  shell: 'posix' as const,
  script,
  cwd: '.',
  env: {},
})

function buildPlan(ticketId: string, summary = 'Prepare the workspace runtime.'): Record<string, unknown> {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary,
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Repository manifest files are present.'],
      gaps: ['Reusable workspace setup outputs have not been prepared yet.'],
    },
    temp_roots: ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'],
    steps: [
      {
        id: 'bootstrap-workspace',
        title: 'Bootstrap workspace',
        purpose: 'Prepare the runtime for later beads.',
        commands: ['npm run bootstrap'],
        required: true,
        rationale: 'Repository-native setup is required before later execution can reuse the workspace.',
        cautions: ['May take a while on the first run.'],
      },
    ],
    project_commands: {
      prepare: ['npm run bootstrap'],
      test_full: ['npm test'],
      lint_full: ['npm run lint'],
      typecheck_full: ['npm run typecheck'],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Repository-native bootstrap may create local dependency caches.'],
  }
}

function serializePlan(ticketId: string, summary?: string): string {
  return JSON.stringify(buildPlan(ticketId, summary), null, 2)
}

function buildStructuredPlan(ticketId: string, summary = 'Prepare the workspace runtime.') {
  return {
    schemaVersion: 1,
    ticketId,
    artifact: 'execution_setup_plan' as const,
    status: 'draft' as const,
    hostContext: {
      platform: 'linux' as const,
      environment: 'native' as const,
      arch: 'x64',
      availableShells: ['posix' as const],
      preferredShell: 'posix' as const,
    },
    summary,
    readiness: {
      status: 'partial' as const,
      actionsRequired: true,
      evidence: ['Repository manifest files are present.'],
      gaps: ['Reusable workspace setup outputs have not been prepared yet.'],
    },
    tempRoots: ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'],
    workspaceInputs: [],
    workspaceProbes: [],
    gitHooks: {
      policy: 'validate_advisory' as const,
      detected: [],
      validationCommands: [],
    },
    steps: [
      {
        id: 'bootstrap-workspace',
        title: 'Bootstrap workspace',
        purpose: 'Prepare the runtime for later beads.',
        commands: [shellCommand('npm run bootstrap')],
        required: true,
        rationale: 'Repository-native setup is required before later execution can reuse the workspace.',
        cautions: ['May take a while on the first run.'],
      },
    ],
    projectCommands: {
      prepare: [shellCommand('npm run bootstrap')],
      testFull: [shellCommand('npm test')],
      lintFull: [shellCommand('npm run lint')],
      typecheckFull: [shellCommand('npm run typecheck')],
    },
    qualityGatePolicy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      fullProjectFallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Repository-native bootstrap may create local dependency caches.'],
  }
}

function approvalPayload(raw: string) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedContentSha256: contentSha256(raw) }),
  }
}

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')
  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string }) => {
      if (event.type === 'APPROVE_EXECUTION_SETUP_PLAN') {
        storage.patchTicket(String(ticketRef), { status: 'PREPARING_EXECUTION_ENV' })
      } else if (event.type === 'REGENERATE_EXECUTION_SETUP_PLAN') {
        storage.patchTicket(String(ticketRef), { status: 'GENERATING_EXECUTION_SETUP_PLAN' })
      }
      return { value: event.type }
    }),
    getTicketState: vi.fn((ticketRef: string | number) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (!ticket) return null
      return {
        state: ticket.status,
        status: 'active',
        context: {
          ticketId: String(ticketRef),
          projectId: ticket.projectId,
          externalId: ticket.externalId,
          title: ticket.title,
          status: ticket.status,
          lockedMainImplementer: 'mock-model',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: [],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          previousStatus: null,
          error: null,
          errorCodes: [],
          beadProgress: { total: 0, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 3,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    }),
    stopActor: vi.fn(() => true),
    revertTicketToApprovalStatus: vi.fn((ticketRef: string | number, targetStatus: string) => {
      storage.patchTicket(String(ticketRef), { status: targetStatus })
      return { id: 'mock-reverted-actor' }
    }),
  }
})

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-execution-setup-plan-',
  files: {
    'README.md': '# LoopTroop Execution Setup Plan Test\n',
  },
})

async function setupExecutionSetupPlanTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Execution setup plan approval',
    description: 'Verify the execution setup plan approval routes.',
  })

  const init = await initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  patchTicket(ticket.id, {
    status: 'WAITING_EXECUTION_SETUP_APPROVAL',
    branchName: init.branchName,
  })
  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Ticket workspace not initialized')
  mkdirSync(dirname(paths.beadsPath), { recursive: true })
  writeFileSync(paths.beadsPath, `${JSON.stringify({
    id: 'bead-1',
    title: 'Run repository tests',
    testCommands: ['npm test'],
  })}\n`)

  const app = new Hono()
  app.route('/api', ticketRouter)

  return { app, ticket, paths }
}

async function moveTicketToRuntimeSetup(app: Hono, ticket: ReturnType<typeof createTicket>, summary = 'Approved runtime setup plan.') {
  const raw = serializePlan(ticket.externalId, summary)
  upsertLatestPhaseArtifact(
    ticket.id,
    'execution_setup_plan',
    'WAITING_EXECUTION_SETUP_APPROVAL',
    raw,
  )
  const approvalResponse = await app.request(`/api/tickets/${ticket.id}/approve-execution-setup-plan`, {
    method: 'POST',
    ...approvalPayload(raw),
  })
  expect(approvalResponse.status).toBe(200)
  ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
  upsertLatestPhaseArtifact(
    ticket.id,
    'execution_setup_report',
    'PREPARING_EXECUTION_ENV',
    JSON.stringify({ status: 'running', summary: 'Runtime setup started.' }),
  )
  return raw
}

describe('ticketRouter execution setup plan approval routes', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('reads the current execution setup plan draft', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      serializePlan(ticket.externalId),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`)

    expect(response.status).toBe(200)
    const payload = await response.json() as { exists: boolean; plan: { summary: string } }
    expect(payload.exists).toBe(true)
    expect(payload.plan.summary).toBe('Prepare the workspace runtime.')
  })

  it('saves a structured execution setup plan draft', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: {
          ...buildStructuredPlan(ticket.externalId, 'Structured save'),
        },
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { plan: { summary: string } }
    expect(payload.plan.summary).toBe('Structured save')
    const stored = getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')
    expect(stored?.content).toContain('Structured save')
    const receipt = getLatestPhaseArtifact(ticket.id, 'user_edit_receipt:execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')
    expect(receipt).toBeDefined()
    const receiptData = JSON.parse(receipt!.content)
    expect(receiptData).toMatchObject({
      target_artifact: 'execution_setup_plan',
      action: 'save',
      edit_surface: 'structured',
      before: {
        sha256: null,
        item_count: null,
      },
      after: {
        item_count: 1,
      },
    })
    expect(receiptData.after.sha256).toBe(contentSha256(stored!.content))
  })

  it('reimposes the project hook policy on structured and raw saves while preserving validation commands', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    const validationCommand = {
      id: 'validate-pre-commit',
      hook: 'pre-commit',
      command: shellCommand('npm test'),
      purpose: 'Validate the detected hook explicitly.',
    }
    const structuredPlan = {
      ...buildStructuredPlan(ticket.externalId, 'Structured policy tamper'),
      gitHooks: {
        policy: 'use_native_hooks' as const,
        detected: [],
        validationCommands: [validationCommand],
      },
    }
    const structuredResponse = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: structuredPlan }),
    })
    expect(structuredResponse.status).toBe(200)
    await expect(structuredResponse.json()).resolves.toMatchObject({
      plan: {
        gitHooks: {
          policy: 'validate_advisory',
          validationCommands: [{ id: 'validate-pre-commit' }],
        },
      },
    })

    const rawPlan = {
      ...structuredPlan,
      summary: 'Raw policy tamper',
      gitHooks: { ...structuredPlan.gitHooks, policy: 'validate_required' as const },
    }
    const rawContent = serializeExecutionSetupPlan(rawPlan)
    expect(rawContent).toContain(`"ticket_id": "${ticket.externalId}"`)
    const rawResponse = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: rawContent }),
    })
    expect(rawResponse.status, await rawResponse.clone().text()).toBe(200)
    await expect(rawResponse.json()).resolves.toMatchObject({
      plan: {
        summary: 'Raw policy tamper',
        gitHooks: {
          policy: 'validate_advisory',
          validationCommands: [{ id: 'validate-pre-commit' }],
        },
      },
    })
  })

  it('saves a no-op execution setup plan when the workspace is already ready', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: {
          ...buildStructuredPlan(ticket.externalId, 'Workspace already looks ready.'),
          readiness: {
            status: 'ready',
            actionsRequired: false,
            evidence: ['Reusable setup profile already exists.'],
            gaps: [],
          },
          tempRoots: ['.ticket/runtime/execution-setup'],
          steps: [],
          projectCommands: {
            prepare: [],
            testFull: [],
            lintFull: [],
            typecheckFull: [],
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      plan: { readiness: { status: string; actionsRequired: boolean }; steps: unknown[] }
    }
    expect(payload.plan.readiness.status).toBe('ready')
    expect(payload.plan.readiness.actionsRequired).toBe(false)
    expect(payload.plan.steps).toHaveLength(0)
  })

  it('derives readiness from structured setup work instead of trusting an inconsistent edit', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: {
          ...buildStructuredPlan(ticket.externalId, 'Invalid plan'),
          readiness: {
            status: 'ready',
            actionsRequired: false,
            evidence: ['Existing runtime artifacts were found.'],
            gaps: [],
          },
          tempRoots: ['.ticket/runtime/execution-setup'],
          steps: [
            {
              id: 'still-has-step',
              title: 'This should not be allowed',
              purpose: 'Contradicts ready status.',
              commands: [shellCommand('echo invalid')],
              required: false,
              rationale: 'Invalid by design for the test.',
              cautions: [],
            },
          ],
          projectCommands: {
            prepare: [],
            testFull: [],
            lintFull: [],
            typecheckFull: [],
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      plan: { readiness: { status: string; actionsRequired: boolean } }
    }
    expect(payload.plan.readiness).toMatchObject({ status: 'partial', actionsRequired: true })
    expect(getLatestPhaseArtifact(ticket.id, 'user_edit_receipt:execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')).toBeDefined()
  })

  it('starts durable background regeneration with the submitted commentary', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      serializePlan(ticket.externalId),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/regenerate-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentary: 'Use the project-native bootstrap command.' }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { success: boolean; plan?: unknown; status?: string }
    expect(payload.success).toBe(true)
    expect(payload.plan).toBeUndefined()
    expect(payload.status).toBe('GENERATING_EXECUTION_SETUP_PLAN')

    const request = getLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan_regeneration_request',
      'GENERATING_EXECUTION_SETUP_PLAN',
    )
    expect(request?.content).toContain('Use the project-native bootstrap command.')
    expect(getLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
    )).toBeUndefined()
  })

  it('archives the current attempt and creates a new one on regenerate', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      serializePlan(ticket.externalId, 'Original plan.'),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/regenerate-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentary: 'New commentary.' }),
    })

    expect(response.status).toBe(200)

    const approvalAttempts = listPhaseAttempts(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL')
    expect(approvalAttempts).toHaveLength(2)
    // listPhaseAttempts returns newest first
    expect(approvalAttempts[0]!.state).toBe('active')
    expect(approvalAttempts[0]!.attemptNumber).toBe(2)
    expect(approvalAttempts[1]!.state).toBe('archived')
    expect(approvalAttempts[1]!.attemptNumber).toBe(1)
    expect(listPhaseAttempts(ticket.id, 'GENERATING_EXECUTION_SETUP_PLAN')).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'active' }),
      expect.objectContaining({
        attemptNumber: 1,
        state: 'archived',
        archivedReason: 'execution_setup_plan_regenerate',
      }),
    ])

    // Old plan preserved in archived attempt 1
    const oldArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL', 1)
    expect(oldArtifact?.content).toContain('Original plan.')

    // The new active version starts with a durable request; the runner publishes
    // the replacement plan only after the drafting status finishes.
    const request = getLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan_regeneration_request',
      'GENERATING_EXECUTION_SETUP_PLAN',
    )
    expect(request?.content).toContain('New commentary.')
    expect(getLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
    )).toBeUndefined()
  })

  it('reads an archived execution setup plan by phase attempt number', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      serializePlan(ticket.externalId, 'Attempt 1 plan.'),
    )

    // Regenerate to archive attempt 1 and start attempt 2
    await app.request(`/api/tickets/${ticket.id}/regenerate-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentary: 'New run.' }),
    })

    // GET with ?phaseAttempt=1 should return the archived plan
    const archiveResponse = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan?phaseAttempt=1`)
    expect(archiveResponse.status).toBe(200)
    const archivePayload = await archiveResponse.json() as { exists: boolean; plan: { summary: string } | null }
    expect(archivePayload.exists).toBe(true)
    expect(archivePayload.plan?.summary).toBe('Attempt 1 plan.')

    // The active approval attempt remains empty while the new drafting phase runs.
    const activeResponse = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`)
    expect(activeResponse.status).toBe(200)
    const activePayload = await activeResponse.json() as { exists: boolean; plan: { summary: string } | null }
    expect(activePayload.exists).toBe(false)
    expect(activePayload.plan).toBeNull()
  })

  it('rewinds from runtime setup when saving an edited setup plan', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    await moveTicketToRuntimeSetup(app, ticket, 'Approved plan handed to runtime.')
    const paths = getTicketPaths(ticket.id)
    expect(paths).toBeDefined()
    mkdirSync(paths!.executionSetupDir, { recursive: true })
    mkdirSync(join(paths!.executionSetupDir, 'tool-cache'), { recursive: true })
    writeFileSync(paths!.executionSetupProfilePath, '{"artifact":"execution_setup_profile"}')
    writeFileSync(join(paths!.executionSetupDir, 'runtime-output.txt'), 'temporary setup output')
    writeFileSync(join(paths!.executionSetupDir, 'tool-cache', 'cache.txt'), 'tool cache')

    const response = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: buildStructuredPlan(ticket.externalId, 'Revised setup plan after runtime rewind.'),
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; plan: { summary: string } }
    expect(payload.status).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(payload.plan.summary).toBe('Revised setup plan after runtime rewind.')
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(vi.mocked(revertTicketToApprovalStatus)).toHaveBeenCalledWith(
      ticket.id,
      'WAITING_EXECUTION_SETUP_APPROVAL',
      { skipInitialWorkflowRun: true },
    )

    expect(listPhaseAttempts(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL')).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'active', archivedReason: null }),
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_rewind' }),
    ])
    expect(listPhaseAttempts(ticket.id, 'GENERATING_EXECUTION_SETUP_PLAN')).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_rewind' }),
    ])
    expect(listPhaseAttempts(ticket.id, 'PREPARING_EXECUTION_ENV')).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_rewind' }),
    ])

    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL', 1)?.content)
      .toContain('Approved plan handed to runtime.')
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')?.content)
      .toContain('Revised setup plan after runtime rewind.')
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_report', 'PREPARING_EXECUTION_ENV', 1)?.content)
      .toContain('Runtime setup started.')

    const receipt = getLatestPhaseArtifact(ticket.id, 'user_edit_receipt:execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.content)).toMatchObject({
      action: 'save_and_rewind',
      ticket_status_before: 'PREPARING_EXECUTION_ENV',
      ticket_status_after: 'WAITING_EXECUTION_SETUP_APPROVAL',
      restart: {
        reason: 'execution_setup_runtime_rewind',
      },
    })

    expect(existsSync(paths!.executionSetupProfilePath)).toBe(false)
    expect(existsSync(join(paths!.executionSetupDir, 'runtime-output.txt'))).toBe(false)
    expect(existsSync(join(paths!.executionSetupDir, 'tool-cache', 'cache.txt'))).toBe(true)
  })

  it('rewinds from runtime setup before regenerating the setup plan', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    await moveTicketToRuntimeSetup(app, ticket, 'Approved plan before regenerate rewind.')

    const response = await app.request(`/api/tickets/${ticket.id}/regenerate-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentary: 'Regenerate after runtime setup started.' }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; success: boolean }
    expect(payload.success).toBe(true)
    expect(payload.status).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(getTicketByRef(ticket.id)?.status).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(vi.mocked(revertTicketToApprovalStatus)).not.toHaveBeenCalled()

    expect(listPhaseAttempts(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL')).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'active', archivedReason: null }),
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_regenerate' }),
    ])
    expect(listPhaseAttempts(ticket.id, 'GENERATING_EXECUTION_SETUP_PLAN')).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'active', archivedReason: null }),
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_regenerate' }),
    ])
    expect(listPhaseAttempts(ticket.id, 'PREPARING_EXECUTION_ENV')).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_regenerate' }),
    ])
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL', 1)?.content)
      .toContain('Approved plan before regenerate rewind.')
    expect(getLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan_regeneration_request',
      'GENERATING_EXECUTION_SETUP_PLAN',
    )?.content)
      .toContain('Regenerate after runtime setup started.')
  })

  it('archives a blocked workspace runtime attempt and returns to setup plan approval for editing', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    await moveTicketToRuntimeSetup(app, ticket, 'Approved plan before blocked runtime setup.')
    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      xstateSnapshot: JSON.stringify({ context: { previousStatus: 'PREPARING_EXECUTION_ENV' } }),
      errorMessage: '\u001b[31mWorkspace probe failed.\u001b[39m\n────────',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/edit-execution-setup-plan`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(listPhaseAttempts(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL')).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'active' }),
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_rewind' }),
    ])
    expect(listPhaseAttempts(ticket.id, 'PREPARING_EXECUTION_ENV')).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'archived', archivedReason: 'execution_setup_runtime_rewind' }),
    ])
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL')?.content)
      .toContain('Approved plan before blocked runtime setup.')
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan_notes', 'WAITING_EXECUTION_SETUP_APPROVAL')?.content)
      .toContain('Previous workspace runtime failure:\\nWorkspace probe failed.')
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan_notes', 'WAITING_EXECUTION_SETUP_APPROVAL')?.content)
      .not.toContain('\u001b[31m')
  })

  it('rejects setup-plan edits and regenerations after runtime setup has advanced', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    patchTicket(ticket.id, { status: 'CODING' })

    const editResponse = await app.request(`/api/tickets/${ticket.id}/execution-setup-plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: buildStructuredPlan(ticket.externalId, 'Rejected coding edit.'),
      }),
    })
    expect(editResponse.status).toBe(409)

    const regenerateResponse = await app.request(`/api/tickets/${ticket.id}/regenerate-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentary: 'Too late to rewind.' }),
    })
    expect(regenerateResponse.status).toBe(409)
  })

  it('approves setup commands without requiring an ecosystem manifest', async () => {
    const { app, ticket, paths } = await setupExecutionSetupPlanTicket()
    expect(existsSync(join(paths.worktreePath, 'package.json'))).toBe(false)
    const raw = serializePlan(ticket.externalId)
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      raw,
    )

    const response = await app.request(`/api/tickets/${ticket.id}/approve-execution-setup-plan`, {
      method: 'POST',
      ...approvalPayload(raw),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload.message).toBe('Execution setup plan approved')
    expect(payload.status).toBe('PREPARING_EXECUTION_ENV')

    const receipt = getLatestPhaseArtifact(ticket.id, 'approval_receipt', 'WAITING_EXECUTION_SETUP_APPROVAL')
    expect(receipt).toBeDefined()
    const receiptData = JSON.parse(receipt!.content)
    expect(receiptData.approved_by).toBe('user')
    expect(receiptData.step_count).toBe(1)
    expect(receiptData.command_count).toBe(1)
    expect(receiptData.content_sha256).toBe(contentSha256(raw))
  })

  it('does not repeatedly report drift after backend hook evidence was already stored', async () => {
    const { app, ticket, paths } = await setupExecutionSetupPlanTicket()
    writeFileSync(join(paths.worktreePath, '.pre-commit-config.yaml'), 'repos: []\n')
    const stored = saveExecutionSetupPlan(
      ticket.id,
      lockExecutionSetupPlanDetectedHooks(ticket.id, buildStructuredPlan(ticket.externalId)),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/approve-execution-setup-plan`, {
      method: 'POST',
      ...approvalPayload(stored.raw),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      message: 'Execution setup plan approved',
      status: 'PREPARING_EXECUTION_ENV',
    })
  })

  it('dispatches execution setup plan approval through the generic approve route', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    const raw = serializePlan(ticket.externalId)
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      raw,
    )

    const response = await app.request(`/api/tickets/${ticket.id}/approve`, {
      method: 'POST',
      ...approvalPayload(raw),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload.message).toBe('Execution setup plan approved')
    expect(payload.status).toBe('PREPARING_EXECUTION_ENV')
  })

  it('requires expectedContentSha256 for execution setup plan approval', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      serializePlan(ticket.externalId),
    )

    const response = await app.request(`/api/tickets/${ticket.id}/approve-execution-setup-plan`, {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('Invalid approval payload')
  })

  it('rejects stale execution setup plan approval hashes with 409', async () => {
    const { app, ticket } = await setupExecutionSetupPlanTicket()
    const raw = serializePlan(ticket.externalId)
    const expectedContentSha256 = '0'.repeat(64)
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_plan',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      raw,
    )

    const response = await app.request(`/api/tickets/${ticket.id}/approve-execution-setup-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContentSha256 }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'Stale approval',
      artifactType: 'execution_setup_plan',
      expectedContentSha256,
      currentContentSha256: contentSha256(raw),
    })
  })
})
