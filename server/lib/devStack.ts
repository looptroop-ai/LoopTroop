import { probePort } from './portProbe'

/** Vite's default, and what `npm run dev` uses unless told otherwise. */
const DEV_FRONTEND_PORT_FALLBACK = 5173

/**
 * Whether the development server is up — that is, whether someone is running
 * LoopTroop from a checkout with `npm run dev` rather than as an installed
 * daemon.
 *
 * Worth asking because "not running" is the most confusing thing LoopTroop can
 * say to someone looking straight at its interface. From a checkout, Vite serves
 * that interface and no daemon is ever registered, so `status` and `doctor` are
 * telling the truth about a thing the reader is not asking about.
 *
 * Probed by binding, which is the same test the port check already trusts —
 * both loopback families, because Vite binds `::1` and nothing else by default
 * and a probe of `127.0.0.1` alone would bind happily and call the port free.
 */
export async function isDevStackRunning(): Promise<boolean> {
  const configured = Number(process.env.LOOPTROOP_FRONTEND_PORT)
  const port = Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEV_FRONTEND_PORT_FALLBACK

  const probes = await Promise.all([probePort(port, '127.0.0.1'), probePort(port, '::1')])
  return probes.some((probe) => probe.kind === 'in-use')
}
