import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnectedModelIds, fetchProviderCatalog, flattenCatalogModels } from '../providerCatalog'
import { MAX_COUNCIL_MEMBERS, validateConfiguredModel, validateModelSelection } from '../modelValidation'
import type { OpenCodeCatalogResponse } from '../../../shared/opencodeCatalog'

vi.mock('../providerCatalog', () => ({
  fetchConnectedModelIds: vi.fn(),
  fetchProviderCatalog: vi.fn(),
  flattenCatalogModels: vi.fn(),
}))

const models = Array.from({ length: 11 }, (_, index) => `provider/model-${index + 1}`)

describe('validateModelSelection', () => {
  beforeEach(() => {
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(models)
  })

  it('accepts a ten-member council including the main implementer', async () => {
    const result = await validateModelSelection(models[0], JSON.stringify(models.slice(0, 10)))

    expect(result.councilMembers).toHaveLength(MAX_COUNCIL_MEMBERS)
  })

  it('rejects a council larger than ten members', async () => {
    await expect(
      validateModelSelection(models[0], JSON.stringify(models)),
    ).rejects.toThrow('At most 10 distinct council members are allowed, including the main implementer.')
  })

  it('validates OpenRouter routing suffixes against base models without removing them', async () => {
    const openRouterModels = [
      'openrouter/deepseek/deepseek-v4-flash',
      'openrouter/openrouter/free',
    ]
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(openRouterModels)

    await expect(
      validateModelSelection(
        'openrouter/deepseek/deepseek-v4-flash:floor',
        JSON.stringify(['openrouter/deepseek/deepseek-v4-flash:floor', 'openrouter/openrouter/free:free']),
      ),
    ).resolves.toEqual({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: [
        'openrouter/deepseek/deepseek-v4-flash:floor',
        'openrouter/openrouter/free:free',
      ],
    })
  })

  it('counts OpenRouter routing variants of the same base model only once', async () => {
    vi.mocked(fetchConnectedModelIds).mockResolvedValue([
      'openrouter/deepseek/deepseek-v4-flash',
      'provider/reviewer',
    ])

    await expect(
      validateModelSelection(
        'openrouter/deepseek/deepseek-v4-flash:floor',
        JSON.stringify([
          'openrouter/deepseek/deepseek-v4-flash:nitro',
          'provider/reviewer',
        ]),
      ),
    ).resolves.toEqual({
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash:floor',
      councilMembers: [
        'openrouter/deepseek/deepseek-v4-flash:floor',
        'provider/reviewer',
      ],
    })
  })

  it('rejects unknown routing suffixes for workflow models', async () => {
    const configured = 'provider/implementer'
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(['openrouter/provider/model', configured])

    await expect(validateModelSelection('openrouter/provider/model:invalid', JSON.stringify([configured])))
      .rejects.toThrow('Main implementer model is not configured in OpenCode')
    await expect(validateModelSelection(configured, JSON.stringify(['openrouter/provider/model:invalid'])))
      .rejects.toThrow('Council member models are not configured in OpenCode')
  })
})

describe('validateConfiguredModel', () => {
  beforeEach(() => {
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(models)
  })

  it('accepts any configured model without applying council uniqueness rules', async () => {
    await expect(validateConfiguredModel(models[0])).resolves.toBe(models[0])
  })

  it('validates OpenRouter routing suffixes against the configured base model', async () => {
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(['openrouter/deepseek/deepseek-v4-flash'])

    await expect(validateConfiguredModel(' openrouter/deepseek/deepseek-v4-flash:floor '))
      .resolves.toBe('openrouter/deepseek/deepseek-v4-flash:floor')
  })

  it('rejects a model missing from the connected catalog and skips lookup when unset', async () => {
    await expect(validateConfiguredModel('provider/unknown'))
      .rejects.toThrow('Selected model is not configured in OpenCode: provider/unknown')

    vi.mocked(fetchConnectedModelIds).mockClear()
    await expect(validateConfiguredModel(null)).resolves.toBeNull()
    expect(fetchConnectedModelIds).not.toHaveBeenCalled()
  })

  it('accepts a suffix only when it is supported routing or explicitly in the catalog', async () => {
    const model = 'openrouter/provider/model:custom'
    vi.mocked(fetchConnectedModelIds).mockResolvedValue(['openrouter/provider/model'])
    await expect(validateConfiguredModel(model)).rejects.toThrow('not configured in OpenCode')

    vi.mocked(fetchConnectedModelIds).mockResolvedValue([model])
    await expect(validateConfiguredModel(model)).resolves.toBe(model)
  })

  it('validates an explicit variant against the connected model catalog', async () => {
    const model = 'openrouter/deepseek/deepseek-v4-flash:floor'
    vi.mocked(fetchProviderCatalog).mockResolvedValue({} as unknown as OpenCodeCatalogResponse)
    vi.mocked(flattenCatalogModels).mockReturnValue([
      {
        fullId: 'openrouter/deepseek/deepseek-v4-flash',
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        providerID: 'openrouter',
        providerName: 'OpenRouter',
        family: '',
        costInput: null,
        costOutput: null,
        contextWindow: 0,
        canReason: null,
        canUseTools: null,
        canSeeImages: null,
        status: 'active',
        variants: { high: {} },
      },
    ])

    await expect(validateConfiguredModel(model, 'high')).resolves.toBe(model)
    await expect(validateConfiguredModel(model, 'unsupported'))
      .rejects.toThrow('Selected variant is not configured for OpenCode model openrouter/deepseek/deepseek-v4-flash:floor: unsupported')
    expect(fetchProviderCatalog).toHaveBeenCalledTimes(2)
    expect(flattenCatalogModels).toHaveBeenCalledWith({}, 'connected')
    expect(fetchConnectedModelIds).not.toHaveBeenCalled()
  })

  it('accepts an exact catalog routing model even when its unsuffixed base is unavailable', async () => {
    const model = 'openrouter/provider/model:free'
    const reviewer = 'provider/reviewer'
    vi.mocked(fetchConnectedModelIds).mockResolvedValue([model, reviewer])

    await expect(validateConfiguredModel(model)).resolves.toBe(model)
    await expect(validateModelSelection(model, JSON.stringify([reviewer]))).resolves.toMatchObject({
      mainImplementer: model, councilMembers: [model, reviewer],
    })
  })
})
