import { describe, expect, it, vi } from 'vitest'
import {
  beginOpenCodePromptActivity,
  ProviderCatalogBusyError,
  waitForOpenCodePromptActivity,
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

  it('lets an incoming prompt wait for reload completion before taking the lease', async () => {
    let finishBusyCheck: (() => void) | undefined
    const checked = new Promise<void>(resolve => { finishBusyCheck = resolve })
    let markChecked: (() => void) | undefined
    const busyCheckStarted = new Promise<void>(resolve => { markChecked = resolve })
    const reload = vi.fn(async () => 'reloaded')
    const reloadPromise = withProviderCatalogReload(async () => {
      markChecked?.()
      await checked
    }, reload)

    await busyCheckStarted
    const promptLease = waitForOpenCodePromptActivity()
    expect(reload).not.toHaveBeenCalled()
    finishBusyCheck?.()
    await expect(reloadPromise).resolves.toBe('reloaded')
    const releasePrompt = await promptLease

    await expect(withProviderCatalogReload(async () => {}, async () => {}))
      .rejects.toBeInstanceOf(ProviderCatalogBusyError)
    releasePrompt()
  })

  it('removes an aborted prompt from the reload wait queue', async () => {
    let finishBusyCheck: (() => void) | undefined
    const checked = new Promise<void>(resolve => { finishBusyCheck = resolve })
    let markChecked: (() => void) | undefined
    const busyCheckStarted = new Promise<void>(resolve => { markChecked = resolve })
    const reloadPromise = withProviderCatalogReload(async () => {
      markChecked?.()
      await checked
    }, async () => 'reloaded')

    await busyCheckStarted
    const controller = new AbortController()
    const promptLease = waitForOpenCodePromptActivity(controller.signal)
    controller.abort()
    await expect(promptLease).rejects.toMatchObject({ name: 'AbortError' })
    finishBusyCheck?.()
    await expect(reloadPromise).resolves.toBe('reloaded')

    const releasePrompt = beginOpenCodePromptActivity()
    releasePrompt()
  })
})
