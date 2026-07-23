import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/shared/Toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProfileSetup } from '../ProfileSetup'
import { OPENCODE_MODELS_QUERY_KEY } from '@/hooks/useOpenCodeModels'

const updateProfileMutate = vi.fn()
const createProfileMutate = vi.fn()

const existingProfile = {
  id: 1,
  mainImplementer: 'opencode/big-pickle',
  mainImplementerVariant: null as string | null,
  councilMembers: JSON.stringify(['opencode/big-pickle', 'openai/gpt-5.1-codex']),
  councilMemberVariants: null as string | null,
  minCouncilQuorum: 1,
  perIterationTimeout: 1_200_000,
  executionSetupTimeout: 1_500_000,
  councilResponseTimeout: 1_200_000,
  interviewQuestions: 50,
  coverageFollowUpBudgetPercent: 20,
  maxCoveragePasses: 2,
  maxPrdCoveragePasses: 5,
  maxBeadsCoveragePasses: 5,
  structuredRetryCount: 1,
  maxIterations: 5,
  opencodeRetryLimit: 7,
  opencodeRetryDelay: 45_000,
  toolInputMaxChars: 4000,
  toolOutputMaxChars: 12000,
  toolErrorMaxChars: 6000,
  manualQaEnabled: false,
  gitHookPolicy: 'use_on_internal_commits' as const,
  createdAt: '2026-03-08T14:28:53.309Z',
  updatedAt: '2026-03-11T10:49:38.623Z',
}
let profileForTest = existingProfile

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: profileForTest }),
  useCreateProfile: () => ({
    mutate: createProfileMutate,
    isPending: false,
    error: null,
  }),
  useUpdateProfile: () => ({
    mutate: updateProfileMutate,
    isPending: false,
    error: null,
  }),
}))

vi.mock('../ModelPicker', () => ({
  ModelPicker: ({ value, placeholder = 'Search models…' }: { value?: string; placeholder?: string }) => (
    <button type="button">{value || placeholder}</button>
  ),
}))

vi.mock('@/components/shared/DropdownPicker', () => ({
  DropdownPicker: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}))

async function renderProfileSetup(queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: false, gcTime: Infinity },
  },
})) {
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <ProfileSetup onClose={() => undefined} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })

  return queryClient
}

describe('ProfileSetup', () => {
  beforeEach(() => {
    updateProfileMutate.mockReset()
    createProfileMutate.mockReset()
    profileForTest = existingProfile
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === '/api/health/opencode') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' }),
        }
      }

      return {
        ok: true,
        json: async () => ({
          models: [{ fullId: 'opencode/big-pickle' }],
          connectedProviders: ['opencode'],
          defaultModels: {},
        }),
      }
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps single-member quorum profiles editable and shows a Save action', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    })
    const refetchQueriesSpy = vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue()
    await renderProfileSetup(queryClient)

    expect(screen.getByText('Minimum council votes required (1–6)')).toBeInTheDocument()
    expect(screen.getByText('Coverage')).toBeInTheDocument()
    expect(screen.getByText('OpenCode Provider Recovery')).toBeInTheDocument()
    expect(screen.getByText('Post-Implementation')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Coverage Follow-Up Budget (%)')).toBeInTheDocument()
    expect(screen.getByText('Interview Coverage Passes')).toBeInTheDocument()
    expect(screen.getByText('Structured Output Retries')).toBeInTheDocument()
    expect(screen.getByText('PRD Coverage Passes')).toBeInTheDocument()
    expect(screen.getByText('Beads Coverage Passes')).toBeInTheDocument()
    expect(screen.getByText('OpenCode Retry Limit')).toBeInTheDocument()
    expect(screen.getByText('OpenCode Retry Grace Window (s)')).toBeInTheDocument()
    expect(screen.getByLabelText('OpenCode Retry Limit')).toHaveValue(7)
    expect(screen.getByLabelText('OpenCode Retry Grace Window')).toHaveValue(45)
    expect(screen.getByText('Execution Setup Timeout (s)')).toBeInTheDocument()
    expect(screen.getByText('Pre-Implementation')).toBeInTheDocument()
    expect(screen.getByText('Implementation & Workspace Setup')).toBeInTheDocument()
    expect(screen.queryByText('Execution Phase')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Run' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Profile')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByText('Icon')).not.toBeInTheDocument()
    expect(screen.queryByText('Background')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await waitFor(() => {
      expect(screen.getByText('OpenCode connected and working')).toBeInTheDocument()
    })
    expect(refetchQueriesSpy).toHaveBeenCalledWith({
      queryKey: ['opencode-models'],
      type: 'active',
    })
  })

  it('allows a council of ten models including the main implementer', async () => {
    await renderProfileSetup()

    const addButton = screen.getByRole('button', { name: 'Add Council Member' })
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)

    expect(screen.getByText('Council member 10…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Council Member' })).not.toBeInTheDocument()
  })

  it('normalizes legacy None effort selections to unset configuration overrides on save', async () => {
    profileForTest = {
      ...existingProfile,
      mainImplementerVariant: 'none',
      councilMemberVariants: JSON.stringify({ 'openai/gpt-5.1-codex': 'none' }),
    }
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') {
        return { ok: true, json: async () => ({ status: 'ok' }) } as Response
      }
      return {
        ok: true,
        json: async () => ({
          models: [
            { fullId: 'opencode/big-pickle', variants: { low: {}, high: {} } },
            { fullId: 'openai/gpt-5.1-codex', variants: { low: {}, high: {} } },
          ],
          connectedProviders: ['opencode', 'openai'],
          defaultModels: {},
        }),
      } as Response
    })

    await renderProfileSetup()

    const noneButtons = await screen.findAllByRole('button', { name: /None/ })
    expect(noneButtons).toHaveLength(2)
    noneButtons.forEach(button => expect(button).toHaveAttribute('aria-pressed', 'true'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImplementerVariant: '',
        councilMemberVariants: '',
      }),
      expect.anything(),
    ))
  })

  it('renders documentation links for configuration descriptions', async () => {
    await renderProfileSetup()

    const docsLinks = screen.getAllByRole('link', { name: /Open documentation for / })
    expect(docsLinks).toHaveLength(21)

    expect(screen.getByRole('link', { name: 'Open documentation for Manual QA checkpoint' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Git hook policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#git-hook-policy`,
    )

    const mainImplementerLink = screen.getByRole('link', { name: 'Open documentation for Main Implementer Model' })
    expect(mainImplementerLink).toHaveAttribute('href', `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#main-implementer-model`)
    expect(mainImplementerLink).toHaveAttribute('target', '_blank')
    expect(mainImplementerLink).toHaveAttribute('rel', 'noreferrer noopener')

    expect(screen.getByRole('link', { name: 'Open documentation for AI Response Timeout' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#ai-response-timeout`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Interview Coverage Passes' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#interview-coverage-passes`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Structured Output Retries' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#structured-output-retries`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for PRD Coverage Passes' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#prd-coverage-passes`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Beads Coverage Passes' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#beads-coverage-passes`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Max Bead Retries' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#max-bead-retries`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for OpenCode Retry Limit' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#opencode-retry-limit`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for OpenCode Retry Grace Window' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#opencode-retry-grace-window`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for OpenCode Max Steps' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#opencode-max-steps`,
    )

    fireEvent.focus(mainImplementerLink)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Select the primary model that writes and implements code. You can choose any available OpenCode model. Open the detailed documentation.',
    )

    const responseTimeoutLink = screen.getByRole('link', { name: 'Open documentation for AI Response Timeout' })
    fireEvent.focus(responseTimeoutLink)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Wait time for planning and other AI-only responses (10–3600s). Open the detailed documentation.',
    )
  })

  it('keeps seconds and editable duration parts synchronized for every duration field', async () => {
    await renderProfileSetup()

    const durationFields = [
      'AI Response Timeout',
      'Execution Setup Timeout',
      'Per-Iteration Timeout',
      'OpenCode Retry Grace Window',
    ]
    for (const label of durationFields) {
      expect(screen.getByLabelText(`${label} minutes`)).toBeEnabled()
      expect(screen.getByLabelText(`${label} seconds`)).toBeEnabled()
    }

    const responseTimeout = screen.getByLabelText('AI Response Timeout')
    fireEvent.change(responseTimeout, { target: { value: '9' } })
    expect(screen.getByLabelText('AI Response Timeout minutes')).toBeDisabled()
    fireEvent.change(responseTimeout, { target: { value: '10' } })
    expect(screen.getByLabelText('AI Response Timeout minutes')).toBeEnabled()

    fireEvent.change(responseTimeout, { target: { value: '90' } })
    expect(screen.getByLabelText('AI Response Timeout minutes')).toHaveValue(1)
    expect(screen.getByLabelText('AI Response Timeout seconds')).toHaveValue(30)

    fireEvent.change(screen.getByLabelText('AI Response Timeout minutes'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('AI Response Timeout seconds'), { target: { value: '5' } })
    expect(responseTimeout).toHaveValue(1205)

    const setupTimeout = screen.getByLabelText('Execution Setup Timeout')
    fireEvent.change(setupTimeout, { target: { value: '0' } })
    expect(screen.getByLabelText('Execution Setup Timeout minutes')).toHaveValue(0)
    expect(screen.getByLabelText('Execution Setup Timeout seconds')).toHaveValue(0)
    expect(screen.getByLabelText('Execution Setup Timeout minutes')).toBeEnabled()

    fireEvent.change(setupTimeout, { target: { value: '' } })
    expect(screen.getByLabelText('Execution Setup Timeout minutes')).toBeDisabled()
    expect(screen.getByLabelText('Execution Setup Timeout seconds')).toBeDisabled()

    fireEvent.change(setupTimeout, { target: { value: '3600' } })
    expect(screen.getByLabelText('Execution Setup Timeout minutes')).toHaveValue(60)
    expect(screen.getByLabelText('Execution Setup Timeout seconds')).toHaveValue(0)
  })

  it('saves duration-part edits through the existing millisecond payload', async () => {
    await renderProfileSetup()

    fireEvent.change(screen.getByLabelText('Execution Setup Timeout minutes'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Execution Setup Timeout seconds'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('OpenCode Retry Grace Window minutes'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('OpenCode Retry Grace Window seconds'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionSetupTimeout: 1_230_000,
        opencodeRetryDelay: 65_000,
      }),
      expect.anything(),
    ))
  })

  it('explains the timeout boundaries in field help', async () => {
    await renderProfileSetup()

    const aiHelp = screen.getByRole('button', { name: 'AI Response Timeout help' })
    fireEvent.focus(aiHelp)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'It does not apply to coding attempts or pre-implementation workspace setup',
    )
    fireEvent.blur(aiHelp)

    const setupHelp = screen.getByRole('button', { name: 'Execution Setup Timeout help' })
    fireEvent.focus(setupHelp)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'every genuine retry receives a fresh full budget',
    )
  })

  it('validates PRD, beads, structured retry, and OpenCode retry numeric inputs', async () => {
    await renderProfileSetup()

    const prdInput = screen.getByLabelText('PRD Coverage Passes') as HTMLInputElement
    const beadsInput = screen.getByLabelText('Beads Coverage Passes') as HTMLInputElement
    const structuredRetryInput = screen.getByLabelText('Structured Output Retries') as HTMLInputElement
    const opencodeRetryLimitInput = screen.getByLabelText('OpenCode Retry Limit') as HTMLInputElement
    const opencodeRetryDelayInput = screen.getByLabelText('OpenCode Retry Grace Window') as HTMLInputElement

    fireEvent.change(prdInput, { target: { value: '1' } })
    fireEvent.change(beadsInput, { target: { value: '21' } })
    fireEvent.change(structuredRetryInput, { target: { value: '6' } })
    fireEvent.change(opencodeRetryLimitInput, { target: { value: '51' } })
    fireEvent.change(opencodeRetryDelayInput, { target: { value: '3601' } })

    expect(screen.getByText('Minimum is 2')).toBeInTheDocument()
    expect(screen.getByText('Maximum is 20')).toBeInTheDocument()
    expect(screen.getByText('Maximum is 5')).toBeInTheDocument()
    expect(screen.getByText('Maximum is 50')).toBeInTheDocument()
    expect(screen.getByText('Maximum is 3600')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('reload button clears cache and strongly refreshes OpenCode models', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    })
    const removeQueriesSpy = vi.spyOn(queryClient, 'removeQueries')
    await renderProfileSetup(queryClient)
    await waitFor(() => expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toBeDefined())

    let finishRefresh: (() => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/models/refresh') {
        await new Promise<void>((resolve) => { finishRefresh = resolve })
      }
      return {
        ok: true,
        json: async () => ({
          models: [{ fullId: 'opencode/big-pickle' }],
          connectedProviders: ['opencode'],
          defaultModels: {},
        }),
      } as Response
    })

    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    expect(reloadBtn).toBeInTheDocument()

    act(() => {
      fireEvent.click(reloadBtn)
    })

    expect(reloadBtn).toBeDisabled()
    expect(reloadBtn.querySelector('svg')).toHaveClass('animate-spin')

    expect(removeQueriesSpy).toHaveBeenCalledWith({
      queryKey: ['opencode-models'],
    })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    }))
    await act(async () => { finishRefresh?.() })
    await waitFor(() => expect(reloadBtn).not.toBeDisabled())
    expect(reloadBtn.querySelector('svg')).not.toHaveClass('animate-spin')
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual({
      models: [{ fullId: 'opencode/big-pickle' }],
      connectedProviders: ['opencode'],
      defaultModels: {},
    })
  })

  it('renders an About button and calls the provided handler', async () => {
    const onOpenAbout = vi.fn()

    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
          },
        })}>
          <TooltipProvider>
            <ToastProvider>
              <ProfileSetup onClose={() => undefined} onOpenAbout={onOpenAbout} />
            </ToastProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      )
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(onOpenAbout).toHaveBeenCalledTimes(1)
  })
})
