const DEFAULT_FRONTEND_PORT = 5173
export const DEFAULT_BACKEND_PORT = 3000
const DEFAULT_BACKEND_HOST = '127.0.0.1'
export const DEFAULT_OPENCODE_BASE_URL = 'http://127.0.0.1:4096'

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return fallback
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback
}

function parseOrigin(value: string | undefined, fallback: string, envName: string): string {
  if (!value) {
    return fallback
  }

  try {
    return new URL(value).origin
  } catch {
    console.warn(`[config] Invalid ${envName}: ${value}. Falling back to ${fallback}.`)
    return fallback
  }
}

export function getFrontendPort(): number {
  return parsePort(process.env.LOOPTROOP_FRONTEND_PORT, DEFAULT_FRONTEND_PORT)
}

export function getBackendPort(): number {
  return parsePort(process.env.LOOPTROOP_BACKEND_PORT, DEFAULT_BACKEND_PORT)
}

export function getBackendHost(): string {
  return process.env.LOOPTROOP_BACKEND_HOST?.trim() || DEFAULT_BACKEND_HOST
}

/**
 * True for a dotted-quad IPv4 address, each octet 0-255 with no leading zeros.
 *
 * `startsWith('127.')` is not an address test. It accepts `127.999.0.1`, and it
 * accepts the *hostname* `127.attacker.example`, which resolves to whatever its
 * owner points it at — so a name under someone else's control passed the
 * loopback check the host guard relies on.
 */
function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const octet = Number(part)
    if (octet > 255) return null
    octets.push(octet)
  }
  return octets as [number, number, number, number]
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '::ffff:7f00:1'
  ) return true
  // The whole 127.0.0.0/8 block is loopback, but only as an address.
  return parseIPv4(normalized)?.[0] === 127
}

/**
 * Enforces the loopback-only boundary for any candidate bind host, whether it
 * came from the environment or from an embedding host.
 */
export function assertAllowedBackendHost(host: string): string {
  if (!isLoopbackHost(host) && process.env.LOOPTROOP_ALLOW_REMOTE_API !== '1') {
    throw new Error(
      `Refusing to bind LoopTroop API to non-loopback host "${host}". ` +
      'Set LOOPTROOP_ALLOW_REMOTE_API=1 only when you understand the local-control API exposure.',
    )
  }
  if (!isLoopbackHost(host) && !process.env.LOOPTROOP_API_TOKEN?.trim()) {
    throw new Error(
      `LOOPTROOP_API_TOKEN must be set when binding to non-loopback host "${host}". ` +
      'An unauthenticated control-plane API must not be exposed to the network.',
    )
  }
  return host
}

export function getAllowedBackendHost(): string {
  return assertAllowedBackendHost(getBackendHost())
}

export function getFrontendOrigin(): string {
  const defaultFrontendOrigin = `http://localhost:${getFrontendPort()}`
  return parseOrigin(process.env.LOOPTROOP_FRONTEND_ORIGIN, defaultFrontendOrigin, 'LOOPTROOP_FRONTEND_ORIGIN')
}

/**
 * Public documentation site. Used as the default so in-app links work for
 * installed users, who have no local docs server running.
 */
const DEFAULT_DOCS_ORIGIN = 'https://www.looptroop.ovh'

export function getDocsOrigin(): string {
  return parseOrigin(process.env.LOOPTROOP_DOCS_ORIGIN, DEFAULT_DOCS_ORIGIN, 'LOOPTROOP_DOCS_ORIGIN')
}

export function getDocsBaseUrl(): string {
  return new URL('/docs/', getDocsOrigin()).toString().replace(/\/$/, '')
}

export function getBackendOrigin(): string {
  const host = getBackendHost()
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${urlHost}:${getBackendPort()}`
}
