import { describe, expect, it } from 'vitest'
import { getDevProxyOriginOverride } from '../scripts/dev-api-proxy'

describe('getDevProxyOriginOverride', () => {
  const backendOrigin = 'http://127.0.0.1:3000'

  it.each([
    {
      label: 'the HTTPS Tailscale development URL',
      origin: 'https://devbox.example-tailnet.ts.net:8443',
      host: 'devbox.example-tailnet.ts.net:8443',
    },
    {
      label: 'an HTTP LAN development URL',
      origin: 'http://192.168.1.42:5173',
      host: '192.168.1.42:5173',
    },
  ])('rewrites $label when the browser reports same-origin', ({ origin, host }) => {
    expect(getDevProxyOriginOverride({
      origin,
      host,
      secFetchSite: 'same-origin',
      backendOrigin,
    })).toBe(backendOrigin)
  })

  it('compares DNS authorities case-insensitively', () => {
    expect(getDevProxyOriginOverride({
      origin: 'https://DEVBOX.EXAMPLE-TAILNET.TS.NET:8443',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-origin',
      backendOrigin,
    })).toBe(backendOrigin)
  })

  it.each([
    {
      label: 'cross-site fetch metadata',
      origin: 'https://attacker.example',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'cross-site',
    },
    {
      label: 'same-site fetch metadata',
      origin: 'https://devbox.example-tailnet.ts.net:8443',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-site',
    },
    {
      label: 'an unrelated origin despite same-origin fetch metadata',
      origin: 'https://attacker.example',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-origin',
    },
    {
      label: 'a mismatched port',
      origin: 'https://devbox.example-tailnet.ts.net:8443',
      host: 'devbox.example-tailnet.ts.net:5173',
      secFetchSite: 'same-origin',
    },
    {
      label: 'a malformed origin',
      origin: 'not a URL',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-origin',
    },
    {
      label: 'an opaque origin',
      origin: 'null',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-origin',
    },
    {
      label: 'missing fetch metadata',
      origin: 'https://devbox.example-tailnet.ts.net:8443',
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: undefined,
    },
    {
      label: 'a missing origin',
      origin: undefined,
      host: 'devbox.example-tailnet.ts.net:8443',
      secFetchSite: 'same-origin',
    },
    {
      label: 'a missing host',
      origin: 'https://devbox.example-tailnet.ts.net:8443',
      host: undefined,
      secFetchSite: 'same-origin',
    },
  ])('does not rewrite $label', ({ origin, host, secFetchSite }) => {
    expect(getDevProxyOriginOverride({
      origin,
      host,
      secFetchSite,
      backendOrigin,
    })).toBeNull()
  })
})
