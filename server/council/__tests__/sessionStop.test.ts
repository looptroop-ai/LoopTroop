import { describe, expect, it } from 'vitest'
import { waitForCouncilSession } from '../sessionStop'

describe('council session cleanup coordination', () => {
  it('bounds a late session-create wait when execution ignores cancellation', async () => {
    const sessionReady = new Promise<void>(() => {})
    const executionSettled = new Promise<void>(() => {})

    await expect(waitForCouncilSession(sessionReady, executionSettled, 10)).resolves.toBe('timed_out')
  })

  it('lets cleanup stop a session as soon as its id is published', async () => {
    let resolveSessionReady!: () => void
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve
    })
    const executionSettled = new Promise<void>(() => {})
    const wait = waitForCouncilSession(sessionReady, executionSettled, 1000)

    resolveSessionReady()

    await expect(wait).resolves.toBe('session_ready')
  })
})
