import { describe, expect, it, vi } from 'vitest'
import {
  beginOpenCodePromptActivity,
  ProviderCatalogBusyError,
  withProviderCatalogReload,
} from '../providerCatalogReload'

describe('provider catalog reload activity gate', () => {
  it('rejects a reload while a prompt is active', async () => {
    const releasePrompt = beginOpenCodePromptActivity()
    const assertIdle = vi.fn(async () => {})
    const reload = vi.fn(async () => 'reloaded')
    try {
      await expect(withProviderCatalogReload(assertIdle, reload)).rejects.toBeInstanceOf(ProviderCatalogBusyError)
      expect(assertIdle).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      releasePrompt()
    }
  })

  it('blocks new prompts from the busy check through reload completion', async () => {
    let finishBusyCheck: (() => void) | undefined
    const checked = new Promise<void>((resolve) => { finishBusyCheck = resolve })
    let markChecked: (() => void) | undefined
    const busyCheckStarted = new Promise<void>((resolve) => { markChecked = resolve })
    const reloadPromise = withProviderCatalogReload(async () => {
      markChecked?.()
      await checked
    }, async () => 'reloaded')

    await busyCheckStarted
    expect(() => beginOpenCodePromptActivity()).toThrow(ProviderCatalogBusyError)
    finishBusyCheck?.()
    await expect(reloadPromise).resolves.toBe('reloaded')

    const releasePrompt = beginOpenCodePromptActivity()
    releasePrompt()
  })
})
