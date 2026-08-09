import { describe, it, expect } from 'vitest'
import { describeOpenCodeForStatus } from '../server/cli/commands'

/**
 * `looptroop status` answered one question — is the daemon running — and a
 * daemon whose OpenCode had crashed three times answered it with "yes".
 * Everything the tool exists to do was unavailable, and nothing in the output
 * said so, or gave a person anything to search for.
 */
describe('status output for OpenCode', () => {
  const baseUrl = 'http://127.0.0.1:4096'

  it('leads with the failure when the supervisor gave up', () => {
    const line = describeOpenCodeForStatus({
      baseUrl,
      owned: false,
      status: 'degraded',
      detail: 'OpenCode exited 3 times; giving up.',
    })

    expect(line).toContain('unavailable')
    // The reason, not just the verdict: it is the difference between a missing
    // binary and a port conflict, and the user is the one who has to fix it.
    expect(line).toContain('OpenCode exited 3 times; giving up.')
  })

  it('says who started the server, which is who may stop it', () => {
    expect(describeOpenCodeForStatus({ baseUrl, owned: true, status: 'managed', pid: 4242 }))
      .toBe(`${baseUrl} (started by LoopTroop, pid 4242)`)
    expect(describeOpenCodeForStatus({ baseUrl, owned: false, status: 'adopted' }))
      .toBe(`${baseUrl} (started elsewhere)`)
  })

  it('distinguishes degraded from adopted, which one field could not', () => {
    const degraded = describeOpenCodeForStatus({ baseUrl, owned: false, status: 'degraded', detail: 'gone' })
    const adopted = describeOpenCodeForStatus({ baseUrl, owned: false, status: 'adopted' })

    expect(degraded).not.toBe(adopted)
  })

  it('names mock mode rather than reporting a server that does not exist', () => {
    expect(describeOpenCodeForStatus(undefined)).toContain('mock mode')
  })

  /**
   * A daemon started by an older build is still running while the new CLI reads
   * its file. `owned` is everything that record says, and inventing a status
   * from it would report an adopted server as one LoopTroop can stop.
   */
  it('reports only what an older record actually said', () => {
    expect(describeOpenCodeForStatus({ baseUrl, owned: true })).toBe(`${baseUrl} (started by LoopTroop)`)
    expect(describeOpenCodeForStatus({ baseUrl, owned: false })).toBe(baseUrl)
  })
})
