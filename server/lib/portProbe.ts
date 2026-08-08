import { createServer } from 'node:net'

export type PortProbe =
  | { kind: 'free' }
  | { kind: 'in-use' }
  /** Anything else: no permission to bind, an unusable address, and so on. */
  | { kind: 'error'; message: string }

/**
 * Reports whether a port can be bound right now, by binding it.
 *
 * There is no way to ask this question without answering it in the same
 * instant — anything learned from a process list or a connect attempt is
 * already out of date by the time it is read — so the caller must treat the
 * result as a report about the past, never as a reservation.
 */
export function probePort(port: number, host = '127.0.0.1'): Promise<PortProbe> {
  return new Promise<PortProbe>((done) => {
    const server = createServer()

    server.once('error', (error: NodeJS.ErrnoException) => {
      server.close()
      // EACCES is deliberately not "in use": a privileged port this user may
      // not bind is a different problem with a different remedy.
      done(error.code === 'EADDRINUSE'
        ? { kind: 'in-use' }
        : { kind: 'error', message: error.message })
    })

    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => done({ kind: 'free' }))
    })
  })
}
