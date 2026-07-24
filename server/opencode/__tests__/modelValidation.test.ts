import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnectedModelIds } from '../providerCatalog'
import { MAX_COUNCIL_MEMBERS, validateModelSelection } from '../modelValidation'

vi.mock('../providerCatalog', () => ({
  fetchConnectedModelIds: vi.fn(),
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

  it('normalizes OpenRouter request suffixes before persisting the selection', async () => {
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
      mainImplementer: 'openrouter/deepseek/deepseek-v4-flash',
      councilMembers: ['openrouter/deepseek/deepseek-v4-flash', 'openrouter/openrouter/free'],
    })
  })
})
