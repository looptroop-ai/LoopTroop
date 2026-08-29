import net from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import {
  LOOPBACK_IPV4_MAPPED,
  LOOPBACK_IPV4_MAPPED_HEX,
  LOOPBACK_IPV4_PREFIX,
  LOOPBACK_IPV6,
  WILDCARD_IPV4,
  WILDCARD_IPV6,
} from '../shared/appConfig'

export const LOOPTROOP_DEV_HOST = 'LOOPTROOP_DEV_HOST'
export const NPM_CONFIG_LONG = 'npm_config_long'
export const DEFAULT_DEV_BIND_HOST = WILDCARD_IPV4

export type DevHostModeSource = 'npm-config' | 'env'

export type ResolvedDevHostMode =
  | {
    enabled: false
  }
  | {
    enabled: true
    bindHost: string
    requestedValue: string
    source: DevHostModeSource
  }

export type LanAddress = {
  interfaceName: string
  address: string
}

type Env = Partial<Record<string, string | undefined>>
type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>

const ENABLE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DISABLE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

function hasEnvValue(env: Env, key: string) {
  return Object.prototype.hasOwnProperty.call(env, key)
}

function getHostModeHint(source: DevHostModeSource) {
  return source === 'npm-config'
    ? 'Use npm run dev --lan.'
    : `Use ${LOOPTROOP_DEV_HOST}=1 or ${LOOPTROOP_DEV_HOST}=${DEFAULT_DEV_BIND_HOST}.`
}

function normalizeBracketedIpv6Host(value: string) {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1)
  }

  return value
}

function isValidHostname(value: string) {
  if (value.length > 253) return false

  return value
    .split('.')
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
}

function normalizeExplicitHost(value: string, source: DevHostModeSource) {
  const host = normalizeBracketedIpv6Host(value.trim())

  if (
    !host
    || /\s/.test(host)
    || host.includes('://')
    || host.includes('/')
    || host.includes('@')
  ) {
    throw new Error(`Invalid dev host "${value}". ${getHostModeHint(source)}`)
  }

  if (net.isIP(host) !== 0 || isValidHostname(host)) {
    return host
  }

  throw new Error(`Invalid dev host "${value}". ${getHostModeHint(source)}`)
}

function resolveHostValue(value: string | undefined, source: DevHostModeSource): ResolvedDevHostMode {
  const requestedValue = value ?? ''
  const normalized = requestedValue.trim().toLowerCase()

  if (DISABLE_VALUES.has(normalized)) {
    return { enabled: false }
  }

  if (ENABLE_VALUES.has(normalized)) {
    return {
      enabled: true,
      bindHost: DEFAULT_DEV_BIND_HOST,
      requestedValue,
      source,
    }
  }

  return {
    enabled: true,
    bindHost: normalizeExplicitHost(requestedValue, source),
    requestedValue,
    source,
  }
}

export function resolveDevHostMode({ env = process.env }: { env?: Env } = {}): ResolvedDevHostMode {
  if (hasEnvValue(env, NPM_CONFIG_LONG)) {
    return resolveHostValue(env[NPM_CONFIG_LONG], 'npm-config')
  }

  if (hasEnvValue(env, LOOPTROOP_DEV_HOST)) {
    return resolveHostValue(env[LOOPTROOP_DEV_HOST], 'env')
  }

  return { enabled: false }
}

export function isWildcardHost(host: string) {
  const normalized = normalizeBracketedIpv6Host(host.trim().toLowerCase())
  return normalized === DEFAULT_DEV_BIND_HOST || normalized === WILDCARD_IPV6
}

function isLoopbackDevHost(host: string) {
  const normalized = normalizeBracketedIpv6Host(host.trim().toLowerCase())
  return normalized === 'localhost'
    || normalized === LOOPBACK_IPV6
    || normalized === LOOPBACK_IPV4_MAPPED
    || normalized === LOOPBACK_IPV4_MAPPED_HEX
    || normalized.startsWith(LOOPBACK_IPV4_PREFIX)
}

function formatDevHostForUrl(host: string) {
  const normalized = normalizeBracketedIpv6Host(host.trim())
  return net.isIP(normalized) === 6 ? `[${normalized}]` : normalized
}

export function formatDevHttpUrl(host: string, port: number) {
  return `http://${formatDevHostForUrl(host)}:${port}`
}

export function listLanAddresses(interfaces: NetworkInterfaceMap = networkInterfaces()): LanAddress[] {
  const addresses: LanAddress[] = []
  const seen = new Set<string>()

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || !entry.address) continue
      if (seen.has(entry.address)) continue

      seen.add(entry.address)
      addresses.push({ interfaceName, address: entry.address })
    }
  }

  return addresses
}

function getAdvertisedDevHosts(
  hostMode: ResolvedDevHostMode,
  interfaces: NetworkInterfaceMap = networkInterfaces(),
) {
  if (!hostMode.enabled) return []
  if (isLoopbackDevHost(hostMode.bindHost)) return []
  if (!isWildcardHost(hostMode.bindHost)) return [hostMode.bindHost]

  return listLanAddresses(interfaces).map((address) => address.address)
}

export function getDevLanUrls(options: {
  hostMode: ResolvedDevHostMode
  port: number
  interfaces?: NetworkInterfaceMap
}) {
  return getAdvertisedDevHosts(options.hostMode, options.interfaces)
    .map((host) => formatDevHttpUrl(host, options.port))
}
