import { once } from 'node:events'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { findFreePort } from '../portProbe'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
})

/** A port this test holds, chosen by the operating system so nothing else has it. */
async function hold(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer()
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    port,
    release: async () => {
      servers.splice(servers.indexOf(server), 1)
      await new Promise((done) => server.close(done))
    },
  }
}

describe('findFreePort', () => {
  it('returns a port it can bind', async () => {
    const { port, release } = await hold()
    await release()

    expect(await findFreePort('127.0.0.1', port, 1)).toBe(port)
  })

  it('never returns a port somebody holds', async () => {
    const { port } = await hold()

    expect(await findFreePort('127.0.0.1', port, 1)).toBeNull()
  })

  it('does not look past the last port there is', async () => {
    expect(await findFreePort('127.0.0.1', 65_536, 5)).toBeNull()
  })
})
