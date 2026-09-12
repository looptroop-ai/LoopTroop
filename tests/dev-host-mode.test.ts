import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEV_BIND_HOST,
  getDevLanUrls,
  listLanAddresses,
  LOOPTROOP_DEV_HOST,
  NPM_CONFIG_LONG,
  resolveDevHostMode,
  type ResolvedDevHostMode,
} from '../scripts/dev-host-mode'

const hostModeEnabled = (bindHost: string): ResolvedDevHostMode => ({
  enabled: true,
  bindHost,
  requestedValue: bindHost,
  source: 'env',
})

describe('resolveDevHostMode', () => {
  it('keeps LAN sharing disabled by default', () => {
    expect(resolveDevHostMode({ env: {} })).toEqual({ enabled: false })
  })

  it('supports npm run config flags without the argument forwarding separator', () => {
    expect(resolveDevHostMode({
      env: { [NPM_CONFIG_LONG]: 'true' },
    })).toEqual({
      enabled: true,
      bindHost: DEFAULT_DEV_BIND_HOST,
      requestedValue: 'true',
      source: 'npm-config',
    })
  })

  it('supports an environment fallback for explicit advanced binding', () => {
    expect(resolveDevHostMode({
      env: { [LOOPTROOP_DEV_HOST]: '192.168.1.50' },
    })).toEqual({
      enabled: true,
      bindHost: '192.168.1.50',
      requestedValue: '192.168.1.50',
      source: 'env',
    })
  })

  it('lets npm config disable the environment fallback', () => {
    expect(resolveDevHostMode({
      env: {
        [NPM_CONFIG_LONG]: 'false',
        [LOOPTROOP_DEV_HOST]: '1',
      },
    })).toEqual({ enabled: false })
  })

  it('rejects invalid host values with a clear command hint', () => {
    expect(() => resolveDevHostMode({
      env: { [NPM_CONFIG_LONG]: 'http://0.0.0.0:5173' },
    })).toThrow('Invalid dev host "http://0.0.0.0:5173". Use npm run dev --lan.')

    expect(() => resolveDevHostMode({
      env: { [LOOPTROOP_DEV_HOST]: 'bad host' },
    })).toThrow(`Invalid dev host "bad host". Use ${LOOPTROOP_DEV_HOST}=1 or ${LOOPTROOP_DEV_HOST}=0.0.0.0.`)
  })
})

describe('LAN URL formatting', () => {
  it('formats all detected non-loopback IPv4 interfaces for wildcard host mode', () => {
    const urls = getDevLanUrls({
      hostMode: hostModeEnabled(DEFAULT_DEV_BIND_HOST),
      port: 5173,
      interfaces: {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8', mac: '00:00:00:00:00:00', netmask: '255.0.0.0' }],
        wifi0: [{ address: '192.168.1.22', family: 'IPv4', internal: false, cidr: '192.168.1.22/24', mac: '00:00:00:00:00:01', netmask: '255.255.255.0' }],
        eth0: [{ address: '10.0.0.8', family: 'IPv4', internal: false, cidr: '10.0.0.8/24', mac: '00:00:00:00:00:02', netmask: '255.255.255.0' }],
      },
    })

    expect(urls).toEqual([
      'http://192.168.1.22:5173',
      'http://10.0.0.8:5173',
    ])
  })

  it('returns no LAN URLs when wildcard host mode has no detected network interface', () => {
    expect(getDevLanUrls({
      hostMode: hostModeEnabled(DEFAULT_DEV_BIND_HOST),
      port: 5173,
      interfaces: {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8', mac: '00:00:00:00:00:00', netmask: '255.0.0.0' }],
      },
    })).toEqual([])
  })

  it('uses an explicit non-loopback host directly', () => {
    expect(getDevLanUrls({
      hostMode: hostModeEnabled('devbox.local'),
      port: 5174,
      interfaces: {},
    })).toEqual(['http://devbox.local:5174'])
  })

  it.each(['localhost', '127.5.5.5', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::FFFF:7F00:1]', '::ffff:127.5.5.5', '0:0:0:0:0:ffff:7fff:ffff', '0:0:0:0:0:0:0:1'])('does not advertise loopback-only host %s as a LAN address', (host) => {
    expect(getDevLanUrls({
      hostMode: hostModeEnabled(host),
      port: 5173,
      interfaces: {},
    })).toEqual([])
  })

  it.each(['127.attacker.example', '127.0.0.1.evil.test'])('advertises hostname %s even when it starts with 127.', (host) => {
    expect(getDevLanUrls({
      hostMode: resolveDevHostMode({ env: { [LOOPTROOP_DEV_HOST]: host } }),
      port: 5173,
      interfaces: {},
    })).toEqual([`http://${host}:5173`])
  })

  it.each(['::ffff:192.168.1.50', '[::ffff:192.168.1.50]'])('advertises explicitly configured remote mapped address %s', (host) => {
    expect(getDevLanUrls({
      hostMode: resolveDevHostMode({ env: { [LOOPTROOP_DEV_HOST]: host } }),
      port: 5173,
      interfaces: {},
    })).toEqual(['http://[::ffff:192.168.1.50]:5173'])
  })

  it('deduplicates detected LAN addresses', () => {
    expect(listLanAddresses({
      wifi0: [{ address: '192.168.1.22', family: 'IPv4', internal: false, cidr: '192.168.1.22/24', mac: '00:00:00:00:00:01', netmask: '255.255.255.0' }],
      bridge0: [{ address: '192.168.1.22', family: 'IPv4', internal: false, cidr: '192.168.1.22/24', mac: '00:00:00:00:00:02', netmask: '255.255.255.0' }],
    })).toEqual([{ interfaceName: 'wifi0', address: '192.168.1.22' }])
  })
})
