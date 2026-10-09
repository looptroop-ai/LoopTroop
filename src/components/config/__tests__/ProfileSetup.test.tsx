import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@/components/shared/Toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProfileSetup } from '../ProfileSetup'
import { OPENCODE_MODELS_QUERY_KEY } from '@/hooks/useOpenCodeModels'
import { MODEL_FETCH_RETRY_DELAY_MS } from '@/lib/constants'

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
  aiQuestionsEnabled: true,
  aiQuestionWindow: 300_000,
  gitHookPolicy: 'use_native_hooks' as const,
  ignoreMode: 'local' as const,
  createdAt: '2026-03-08T14:28:53.309Z',
  updatedAt: '2026-03-11T10:49:38.623Z',
}
let profileForTest: typeof existingProfile | null | undefined = existingProfile
let profileLoadingForTest = false

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: profileForTest, isLoading: profileLoadingForTest }),
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
  ModelPicker: ({ id, label, value, placeholder = 'Search models…', onChange, isRefreshing }: {
    id?: string
    label?: string
    value?: string
    placeholder?: string
    onChange?: (modelId: string) => void
    isRefreshing?: boolean
  }) => (
    <button id={id} aria-label={`${label} ${value || placeholder}`} aria-busy={isRefreshing || undefined} type="button" onClick={() => onChange?.('openai/next-model')}>{value || placeholder}</button>
  ),
}))

vi.mock('@/components/shared/DropdownPicker', () => ({
  DropdownPicker: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}))

async function renderProfileSetup(
  queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: false, gcTime: Infinity },
  },
  }),
  onDirtyChange?: (isDirty: boolean) => void,
  onClose: () => void = () => undefined,
) {
  let rendered: ReturnType<typeof render>
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <ProfileSetup onClose={onClose} onDirtyChange={onDirtyChange} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    )
    await Promise.resolve()
  })

  return { queryClient, rendered: rendered! }
}

function openCustomAiQuestionWait() {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
  return screen.getByLabelText('AI question wait')
}

describe('ProfileSetup', () => {
  beforeEach(() => {
    updateProfileMutate.mockReset()
    createProfileMutate.mockReset()
    profileForTest = existingProfile
    profileLoadingForTest = false
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

  it('reports profile values as dirty only while they differ from the hydrated baseline', async () => {
    const onDirtyChange = vi.fn()
    await renderProfileSetup(undefined, onDirtyChange)

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    const waitField = openCustomAiQuestionWait()
    fireEvent.change(waitField, { target: { value: '6' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))

    fireEvent.change(waitField, { target: { value: '5' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('keeps edits dirty when profile hydration resolves without a saved profile', async () => {
    profileForTest = undefined
    profileLoadingForTest = true
    const onDirtyChange = vi.fn()
    const view = await renderProfileSetup(undefined, onDirtyChange)

    const waitField = openCustomAiQuestionWait()
    fireEvent.change(waitField, { target: { value: '6' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))

    profileForTest = null
    profileLoadingForTest = false
    view.rendered.rerender(
      <QueryClientProvider client={view.queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <ProfileSetup onClose={() => undefined} onDirtyChange={onDirtyChange} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText('AI question wait')).toHaveValue(6)
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })

  it('keeps a pre-hydration edit when saved profile data arrives', async () => {
    profileForTest = undefined
    profileLoadingForTest = true
    const onDirtyChange = vi.fn()
    const view = await renderProfileSetup(undefined, onDirtyChange)

    const waitField = openCustomAiQuestionWait()
    fireEvent.change(waitField, { target: { value: '6' } })
    profileForTest = { ...existingProfile, aiQuestionWindow: 900_000 }
    profileLoadingForTest = false
    view.rendered.rerender(
      <QueryClientProvider client={view.queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <ProfileSetup onClose={() => undefined} onDirtyChange={onDirtyChange} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByLabelText('AI question wait')).toHaveValue(6)
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })

  it('keeps the form open and dirty when edits follow an in-flight save', async () => {
    const onClose = vi.fn()
    const onDirtyChange = vi.fn()
    await renderProfileSetup(undefined, onDirtyChange, onClose)

    const waitField = openCustomAiQuestionWait()
    fireEvent.change(waitField, { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateProfileMutate.mock.calls.at(-1)?.[0]).toHaveProperty('aiQuestionWindow', 360_000)
    fireEvent.change(waitField, { target: { value: '7' } })

    const options = updateProfileMutate.mock.calls.at(-1)?.[1] as { onSuccess: () => void }
    await act(async () => { options.onSuccess() })

    expect(onClose).not.toHaveBeenCalled()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('confirms before Cancel discards a dirty profile draft', async () => {
    const onClose = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderProfileSetup(undefined, undefined, onClose)

    fireEvent.change(openCustomAiQuestionWait(), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved profile changes?')
    expect(onClose).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
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

    expect(screen.getByText('Minimum council votes required (1 to 6)')).toBeInTheDocument()
    expect(screen.getByText('Coverage')).toBeInTheDocument()
    expect(screen.getByText('OpenCode Provider Recovery')).toBeInTheDocument()
    const advancedButton = screen.getByRole('button', { name: 'Advanced' })
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('radio', { name: 'Disabled' })).not.toBeInTheDocument()
    fireEvent.click(advancedButton)
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

    expect(screen.getByRole('button', { name: 'Main Implementer Model opencode/big-pickle' })).toHaveAttribute('id', 'main-implementer')
    expect(screen.getByRole('button', { name: 'Council member 2 openai/gpt-5.1-codex' })).toBeInTheDocument()

    const addButton = screen.getByRole('button', { name: 'Add Council Member' })
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)

    expect(screen.getByRole('button', { name: 'Council member 10 Council member 10…' })).toBeInTheDocument()
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

  it('keeps server-provided effort variants selectable when reasoning metadata is unknown', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') {
        return { ok: true, json: async () => ({ status: 'ok' }) } as Response
      }
      return {
        ok: true,
        json: async () => ({
          models: [{
            fullId: 'opencode/big-pickle',
            canReason: null,
            variants: { 'reasoning-balanced': { settings: { reasoningEffort: 'balanced' } } },
          }],
          connectedProviders: ['opencode'],
          defaultModels: {},
        }),
      } as Response
    })

    await renderProfileSetup()
    fireEvent.click(await screen.findByRole('button', { name: /reasoning-balanced/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mainImplementerVariant: 'reasoning-balanced' }),
      expect.anything(),
    ))
  })

  it('treats an empty saved main variant as None when configuration opens', async () => {
    profileForTest = {
      ...existingProfile,
      mainImplementerVariant: '',
    }
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') {
        return { ok: true, json: async () => ({ status: 'ok' }) } as Response
      }
      return {
        ok: true,
        json: async () => ({
          models: [{ fullId: 'opencode/big-pickle', variants: { low: {}, high: {} } }],
          connectedProviders: ['opencode'],
          defaultModels: {},
        }),
      } as Response
    })

    await renderProfileSetup()

    expect(await screen.findByRole('button', { name: '○None' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the main implementer variant in its read-only council row', async () => {
    profileForTest = {
      ...existingProfile,
      mainImplementerVariant: 'high',
    }

    await renderProfileSetup()

    expect(await screen.findByText('· high')).toHaveClass('text-muted-foreground')
    expect(screen.getByText('MAI (auto-included)')).toBeInTheDocument()
  })

  it('resets the effort selection to None when the main model changes', async () => {
    profileForTest = {
      ...existingProfile,
      mainImplementerVariant: 'high',
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
            { fullId: 'openai/next-model', variants: { low: {}, high: {} } },
          ],
          connectedProviders: ['opencode', 'openai'],
          defaultModels: {},
        }),
      } as Response
    })

    await renderProfileSetup()
    expect(await screen.findByRole('button', { name: '●High' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Main Implementer Model opencode/big-pickle' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '○None' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('renders documentation links for configuration descriptions', async () => {
    await renderProfileSetup()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('radio', { name: 'Run' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Run' })).toHaveAttribute('data-state', 'checked')
    const docsLinks = screen.getAllByRole('link', { name: /Open documentation for / })
    expect(docsLinks).toHaveLength(24)

    expect(screen.getByRole('link', { name: 'Open documentation for AI questions' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#ai-questions`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for AI question wait' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#ai-question-wait`,
    )

    expect(screen.getByRole('link', { name: 'Open documentation for Manual QA checkpoint' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#manual-qa`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for Git hook policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#git-hook-policy`,
    )
    expect(screen.getByRole('link', { name: 'Open documentation for configuration folder-ignore policy' })).toHaveAttribute(
      'href',
      `${__LOOPTROOP_DOCS_ORIGIN__}/configuration#looptroop-folder-ignore-policy`,
    )
    expect(screen.getByRole('radio', { name: 'This clone' })).toBeChecked()

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
      'Wait time for planning and other AI-only responses (10 to 3600s). Open the detailed documentation.',
    )
  })

  it('persists Manual QA, hook, and folder-ignore defaults from Advanced', async () => {
    await renderProfileSetup()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Enabled' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Observe' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Repository' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        manualQaEnabled: true,
        gitHookPolicy: 'observe_only',
        ignoreMode: 'repo',
      }),
      expect.anything(),
    ))
  })

  it('shows AI question settings and adjacent help only inside expanded Advanced', async () => {
    await renderProfileSetup()

    const advancedButton = screen.getByRole('button', { name: 'Advanced' })
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('AI questions')).not.toBeInTheDocument()
    expect(screen.queryByText('AI question wait')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'AI questions setting' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'AI question wait source' })).not.toBeInTheDocument()

    fireEvent.click(advancedButton)
    const advanced = within(advancedButton.parentElement!)
    for (const label of ['AI questions', 'AI question wait']) {
      expect(advanced.getByText(label)).toBe(screen.getByText(label))
      expect(advanced.getByText(label).parentElement).toContainElement(
        advanced.getByRole('link', { name: `Open documentation for ${label}` }),
      )
    }
    const waitRow = advanced.getByText('AI question wait').closest('.pl-4')
    expect(waitRow).toHaveClass('pl-4')
    expect(waitRow).not.toHaveClass('border-t')
    expect(waitRow?.previousElementSibling).toContainElement(advanced.getByRole('radiogroup', { name: 'AI questions setting' }))
    expect(advanced.getByRole('radio', { name: 'Default ai question wait' })).toHaveAttribute('aria-checked', 'true')
    expect(advanced.getByText('5 minutes')).toBeInTheDocument()
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()

    fireEvent.focus(advanced.getByRole('link', { name: 'Open documentation for AI question wait' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('1–60 whole minutes')
    expect(screen.getByRole('tooltip')).toHaveTextContent("Waiting does not use up the step's working time.")

    fireEvent.click(advancedButton)
    expect(screen.queryByText('AI questions')).not.toBeInTheDocument()
    expect(screen.queryByText('AI question wait')).not.toBeInTheDocument()
  })

  it('preserves the custom wait when re-enabled and saves its duration while questions is Off', async () => {
    await renderProfileSetup()

    const waitField = openCustomAiQuestionWait()
    expect(screen.getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true')
    expect(waitField).toHaveValue(5)

    fireEvent.change(waitField, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(waitField).toHaveValue(10)
    const modes = within(screen.getByRole('radiogroup', { name: 'AI question wait source' })).getAllByRole('radio')
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    for (const mode of modes) expect(mode).toBeDisabled()
    expect(waitField).toBeDisabled()
    expect(waitField).toHaveValue(10)
    expect(screen.getByRole('radio', { name: 'Set a custom ai question wait' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('radio', { name: 'On' }))
    for (const mode of modes) expect(mode).toBeEnabled()
    expect(waitField).toBeEnabled()
    expect(waitField).toHaveValue(10)
    expect(screen.getByRole('radio', { name: 'Set a custom ai question wait' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        aiQuestionsEnabled: false,
        aiQuestionWindow: 600_000,
      }),
      expect.anything(),
    ))
  })

  it('loads a saved custom wait and resets it to the built-in default', async () => {
    profileForTest = { ...existingProfile, aiQuestionWindow: 900_000 }
    await renderProfileSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByRole('radio', { name: 'Set a custom ai question wait' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('AI question wait')).toHaveValue(15)
    fireEvent.click(screen.getByRole('radio', { name: 'Set a custom ai question wait' }))
    expect(screen.getByLabelText('AI question wait')).toHaveValue(15)

    fireEvent.click(screen.getByRole('radio', { name: 'Default ai question wait' }))
    expect(screen.queryByLabelText('AI question wait')).not.toBeInTheDocument()
    expect(screen.getByText('5 minutes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({ aiQuestionWindow: 300_000 }),
      expect.anything(),
    )
  })

  it('blocks active invalid waits, restores validation on re-enable, and clears it with Default', async () => {
    await renderProfileSetup()
    const waitField = openCustomAiQuestionWait()
    const save = screen.getByRole('button', { name: 'Save' })

    for (const raw of ['0', '61', '2.5', '']) {
      fireEvent.change(waitField, { target: { value: raw } })
      expect(waitField).toHaveValue(raw === '' ? null : Number(raw))
      expect(waitField).toHaveAttribute('aria-invalid', 'true')
      expect(save).toBeDisabled()
      fireEvent.submit(save.closest('form')!)
      expect(updateProfileMutate).not.toHaveBeenCalled()
      expect(createProfileMutate).not.toHaveBeenCalled()
    }

    fireEvent.change(waitField, { target: { value: '10' } })
    expect(save).toBeEnabled()
    fireEvent.change(waitField, { target: { value: '61' } })
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(waitField).toBeDisabled()
    expect(waitField).toHaveValue(61)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(updateProfileMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ aiQuestionsEnabled: false, aiQuestionWindow: 600_000 }),
      expect.anything(),
    )

    fireEvent.click(screen.getByRole('radio', { name: 'On' }))
    expect(waitField).toBeEnabled()
    expect(waitField).toHaveValue(61)
    expect(waitField).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Default ai question wait' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(updateProfileMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ aiQuestionWindow: 300_000 }),
      expect.anything(),
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

  it('surfaces lower and upper duration bounds from the minute and second editors', async () => {
    await renderProfileSetup()

    const setupMinutes = screen.getByLabelText('Execution Setup Timeout minutes')
    expect(setupMinutes).toHaveClass('number-input-no-spinner')

    fireEvent.change(setupMinutes, { target: { value: '-1' } })
    expect(screen.getByText('Minimum is 0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Execution Setup Timeout'), { target: { value: '1200' } })
    expect(screen.getByLabelText('Execution Setup Timeout minutes')).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Execution Setup Timeout seconds'), { target: { value: '60' } })
    expect(screen.getByText('Maximum is 3600')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
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

  it('reload button preserves cached models while strongly refreshing them', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    })
    await renderProfileSetup(queryClient)
    await waitFor(() => expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toBeDefined())
    const cachedModels = queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)

    let finishRefresh: (() => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/models/refresh') {
        await new Promise<void>((resolve) => { finishRefresh = resolve })
      }
      return {
        ok: true,
        json: () => Promise.resolve({
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

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    }))
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedModels)
    await act(() => { finishRefresh?.() })
    await waitFor(() => expect(reloadBtn).not.toBeDisabled())
    expect(reloadBtn.querySelector('svg')).not.toHaveClass('animate-spin')
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual({
      models: [{ fullId: 'opencode/big-pickle' }],
      connectedProviders: ['opencode'],
      defaultModels: {},
    })
  })

  it('lets a manual reload recover while the first model read is pending', async () => {
    let discoverySignal: AbortSignal | undefined
    let finishRefresh: ((response: Response) => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') return new Response(JSON.stringify({ status: 'ok' }))
      if (url === '/api/models') {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          discoverySignal = signal ?? undefined
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return new Promise<Response>((resolve) => { finishRefresh = resolve })
    })
    const { queryClient } = await renderProfileSetup()
    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    await screen.findByText('OpenCode connected, checking models…')
    expect(reloadBtn).toBeEnabled()

    fireEvent.click(reloadBtn)

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    }))
    expect(discoverySignal?.aborted).toBe(true)
    expect(screen.getByText('OpenCode connected, checking models…')).toBeInTheDocument()
    expect(screen.queryByText('OpenCode connected, but no models are available')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Main Implementer Model opencode/big-pickle' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Council member 2 openai/gpt-5.1-codex' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      finishRefresh?.(new Response(JSON.stringify({
        models: [{ fullId: 'openai/recovered-model' }],
        connectedProviders: ['openai'],
        defaultModels: {},
      })))
    })
    await screen.findByText('OpenCode connected and working')
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toMatchObject({
      models: [{ fullId: 'openai/recovered-model' }],
    })
    expect(reloadBtn).toBeEnabled()
  })

  it.each([
    { status: 409, body: { code: 'OPENCODE_BUSY', message: 'OpenCode has active work or unanswered requests.' }, message: 'OpenCode has active work or unanswered requests.' },
    { status: 503, body: { error: 'OpenCode catalog unavailable' }, message: 'Failed to fetch models (HTTP 503: OpenCode catalog unavailable)' },
  ])('resumes first discovery after a failed manual reload (HTTP $status)', async ({ status, body, message }) => {
    let reads = 0
    let finishRefresh: ((response: Response) => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') return new Response(JSON.stringify({ status: 'ok' }))
      if (url === '/api/models/refresh') return new Promise<Response>((resolve) => { finishRefresh = resolve })
      if (++reads === 1) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
      return new Response(JSON.stringify({ models: [{ fullId: 'openai/recovered-model' }], connectedProviders: ['openai'], defaultModels: {} }))
    })
    const { queryClient } = await renderProfileSetup()
    await screen.findByText('OpenCode connected, checking models…')
    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    fireEvent.click(reloadBtn)
    await waitFor(() => expect(finishRefresh).toBeDefined())
    expect(screen.getByText('OpenCode connected, checking models…')).toBeInTheDocument()

    await act(async () => { finishRefresh?.(new Response(JSON.stringify(body), { status })) })

    expect(await screen.findByText(message)).toBeInTheDocument()
    await screen.findByText('OpenCode connected and working')
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toMatchObject({ models: [{ fullId: 'openai/recovered-model' }] })
    expect(reads).toBe(2)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/models/refresh')).toHaveLength(1)
    expect(reloadBtn).toBeEnabled()
  })

  it('keeps refreshed models when a delayed health check starts a stale catalog read', async () => {
    let finishHealth: ((response: Response) => void) | undefined
    let finishRefresh: ((response: Response) => void) | undefined
    const catalogReads: Array<{ finish: (response: Response) => void, signal?: AbortSignal }> = []
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      return new Promise<Response>((resolve) => {
        if (url === '/api/health/opencode') finishHealth = resolve
        else if (url === '/api/models/refresh') finishRefresh = resolve
        else catalogReads.push({ finish: resolve, signal: init?.signal ?? undefined })
      })
    })
    const { queryClient } = await renderProfileSetup()
    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    fireEvent.click(reloadBtn)
    await waitFor(() => expect(finishRefresh).toBeDefined())
    expect(catalogReads[0]?.signal?.aborted).toBe(true)

    await act(async () => { finishHealth?.(new Response(JSON.stringify({ status: 'ok' }))) })
    await waitFor(() => expect(catalogReads).toHaveLength(2))
    await act(async () => {
      finishRefresh?.(new Response(JSON.stringify({
        models: [{ fullId: 'openai/recovered-model' }],
        connectedProviders: ['openai'],
        defaultModels: {},
      })))
    })
    await waitFor(() => expect(reloadBtn).toBeEnabled())

    await act(async () => {
      catalogReads[1]!.finish(new Response(JSON.stringify({ models: [], connectedProviders: [], defaultModels: {} })))
    })

    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toMatchObject({
      models: [{ fullId: 'openai/recovered-model' }],
    })
    expect(screen.getByText('OpenCode connected and working')).toBeInTheDocument()
    expect(catalogReads[1]?.signal?.aborted).toBe(true)
  })

  it.each([
    {
      status: 409,
      body: { code: 'OPENCODE_BUSY', message: 'OpenCode has active work or unanswered requests.' },
      message: 'OpenCode has active work or unanswered requests.',
    },
    {
      status: 503,
      body: { error: 'OpenCode catalog unavailable' },
      message: 'Failed to fetch models (HTTP 503: OpenCode catalog unavailable)',
    },
  ])('shows a failed reload without losing cached models (HTTP $status)', async ({ status, body, message }) => {
    const { queryClient } = await renderProfileSetup()
    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    await waitFor(() => expect(reloadBtn).toBeEnabled())
    const cachedModels = queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)
    expect(cachedModels).toBeDefined()

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
    fireEvent.click(reloadBtn)

    expect(await screen.findByText(message)).toBeInTheDocument()
    await waitFor(() => expect(reloadBtn).toBeEnabled())
    expect(reloadBtn.querySelector('svg')).not.toHaveClass('animate-spin')
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedModels)
  })

  it('reports an unconfirmed reload timeout after a catalog read recovers', async () => {
    const { queryClient } = await renderProfileSetup()
    const reloadBtn = screen.getByRole('button', { name: 'Reload OpenCode providers and models' })
    await waitFor(() => expect(reloadBtn).toBeEnabled())
    const message = 'OpenCode provider reload timed out before completion could be confirmed.'
    const recovered = {
      models: [{ fullId: 'openai/recovered-model' }],
      connectedProviders: ['openai'],
      defaultModels: {},
    }
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [],
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
        message,
        reloadState: 'unknown',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(recovered)))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => {
        fireEvent.click(reloadBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(reloadBtn).toBeDisabled()
      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS + 1) })

      expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(['/api/models/refresh', '/api/models'])
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(recovered)
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(reloadBtn).toBeEnabled()
      expect(reloadBtn.querySelector('svg')).not.toHaveClass('animate-spin')
    } finally {
      vi.useRealTimers()
    }
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

  it('reports disconnected and empty-model states from OpenCode health and discovery', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') return { ok: false } as Response
      return {
        ok: true,
        json: async () => ({ models: [], connectedProviders: [], defaultModels: {} }),
      } as Response
    })

    const { rendered } = await renderProfileSetup()
    expect(await screen.findByText('OpenCode not connected')).toBeInTheDocument()
    expect(rendered.container).toHaveTextContent('Restart LoopTroop (looptroop restart) so it starts OpenCode again')
    // OpenCode v2 makes up a password for every server started by hand, so
    // LoopTroop could never sign in to one this told you to start.
    expect(rendered.container).not.toHaveTextContent('opencode serve')

    rendered.unmount()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') {
        return { ok: true, json: async () => ({ status: 'ok' }) } as Response
      }
      return {
        ok: true,
        json: async () => ({ models: [], connectedProviders: [], defaultModels: {} }),
      } as Response
    })
    await renderProfileSetup()
    expect(await screen.findByText('OpenCode connected, but no models are available')).toBeInTheDocument()
  })

  function mockOpenCodeRefusal(health: Record<string, unknown>) {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/health/opencode') {
        return { ok: true, json: async () => ({ status: 'unavailable', failureKind: 'authentication', ...health }) } as Response
      }
      return {
        ok: true,
        json: async () => ({ models: [], connectedProviders: [], defaultModels: {} }),
      } as Response
    })
  }

  it('asks for the password, not a restart, when OpenCode refused LoopTroop', async () => {
    mockOpenCodeRefusal({})

    const { rendered } = await renderProfileSetup()
    expect(await screen.findByText('OpenCode not connected')).toBeInTheDocument()
    expect(rendered.container).toHaveTextContent(
      "OpenCode is running but refused LoopTroop's sign-in. Set OPENCODE_PASSWORD to that server's password, then run looptroop restart.",
    )
    expect(rendered.container).not.toHaveTextContent('could not reach')
  })

  it('shows the backend advice for a refusal, which knows whether a password was sent', async () => {
    // One sentence telling everyone to set OPENCODE_PASSWORD was wrong for a
    // v1 server, which reads other variables, and for a password that was wrong.
    mockOpenCodeRefusal({
      credentialsSent: true,
      advice: 'OpenCode rejected the configured credentials. Check OPENCODE_PASSWORD for v2, or OPENCODE_SERVER_PASSWORD '
        + 'and OPENCODE_SERVER_USERNAME for v1, then run `looptroop restart`.',
    })
    const { rendered } = await renderProfileSetup()
    expect(await screen.findByText('OpenCode not connected')).toBeInTheDocument()
    expect(rendered.container).toHaveTextContent(
      'OpenCode rejected the configured credentials. Check OPENCODE_PASSWORD for v2, or OPENCODE_SERVER_PASSWORD '
        + 'and OPENCODE_SERVER_USERNAME for v1, then run looptroop restart.',
    )
    expect(screen.getByText('looptroop restart').tagName).toBe('CODE')
    expect(rendered.container).not.toHaveTextContent('refused LoopTroop\'s sign-in')

    rendered.unmount()
    mockOpenCodeRefusal({
      credentialsSent: false,
      advice: 'OpenCode requires a password, and none is configured. Set OPENCODE_PASSWORD to that server\'s password, '
        + 'and OPENCODE_SERVER_USERNAME too if a v1 server\'s user is not `opencode`, then run `looptroop restart`.',
    })
    const second = await renderProfileSetup()
    expect(await screen.findByText('OpenCode not connected')).toBeInTheDocument()
    expect(second.rendered.container).toHaveTextContent(
      'OpenCode requires a password, and none is configured. Set OPENCODE_PASSWORD to that server\'s password, '
        + 'and OPENCODE_SERVER_USERNAME too if a v1 server\'s user is not opencode, then run looptroop restart.',
    )
    expect(screen.getByText('opencode').tagName).toBe('CODE')
    expect(second.rendered.container).not.toHaveTextContent('`')
  })

  it('updates OpenRouter routing preferences while keeping suffixes attached to saved models', async () => {
    profileForTest = {
      ...existingProfile,
      mainImplementer: 'openrouter/anthropic/claude-3.5-sonnet:floor',
      councilMembers: JSON.stringify([
        'openrouter/anthropic/claude-3.5-sonnet:floor',
        'openrouter/google/gemini-2.5-pro:thinking',
      ]),
      councilMemberVariants: JSON.stringify({ 'openrouter/google/gemini-2.5-pro': 'high' }),
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
            { fullId: 'openrouter/anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
            { fullId: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          ],
          connectedProviders: ['openrouter'],
          defaultModels: {},
        }),
      } as Response
    })

    await renderProfileSetup()

    const nitroButtons = screen.getAllByRole('button', { name: 'Nitro' })
    expect(nitroButtons).toHaveLength(2)
    fireEvent.click(nitroButtons[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'Free' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImplementer: 'openrouter/anthropic/claude-3.5-sonnet:nitro',
        councilMembers: JSON.stringify([
          'openrouter/anthropic/claude-3.5-sonnet:nitro',
          'openrouter/google/gemini-2.5-pro:free',
        ]),
        councilMemberVariants: JSON.stringify({ 'openrouter/google/gemini-2.5-pro:free': 'high' }),
      }),
      expect.anything(),
    ))
  })

  it('removes a council member and its saved effort variant together', async () => {
    profileForTest = {
      ...existingProfile,
      councilMemberVariants: JSON.stringify({ 'openai/gpt-5.1-codex': 'high' }),
    }

    await renderProfileSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Remove council member 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        councilMembers: JSON.stringify(['opencode/big-pickle']),
        councilMemberVariants: '',
      }),
      expect.anything(),
    ))
  })

  it('saves edits from the less common numeric settings as validated profile values', async () => {
    await renderProfileSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    const values: Record<string, string> = {
      'OpenCode Max Steps': '99',
      'Min Council Quorum': '2',
      'Max Interview Questions': '30',
      'Coverage Follow-Up Budget': '25',
      'Interview Coverage Passes': '3',
      'Max Bead Retries': '8',
      'Tool Input Max Chars': '5000',
      'Tool Output Max Chars': '14000',
      'Tool Error Max Chars': '7000',
    }
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        opencodeSteps: 99,
        minCouncilQuorum: 2,
        interviewQuestions: 30,
        coverageFollowUpBudgetPercent: 25,
        maxCoveragePasses: 3,
        maxIterations: 8,
        toolInputMaxChars: 5000,
        toolOutputMaxChars: 14000,
        toolErrorMaxChars: 7000,
      }),
      expect.anything(),
    ))
  })

  it('creates a first profile and closes after its save succeeds', async () => {
    profileForTest = null
    const onClose = vi.fn()
    await renderProfileSetup(undefined, undefined, onClose)

    fireEvent.click(screen.getByRole('button', { name: 'Main Implementer Model Search models…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(createProfileMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mainImplementer: 'openai/next-model' }),
      expect.anything(),
    ))
    expect(updateProfileMutate).not.toHaveBeenCalled()
    const options = createProfileMutate.mock.calls[0]?.[1] as { onSuccess: () => void }
    await act(async () => { options.onSuccess() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
