import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from '../shared/appConfig'
import { canonicalAuthority, isLoopbackAuthority, parseOrigin } from '../server/middleware/hostGuard'

const octet = fc.integer({ min: 0, max: 255 })

describe('generated network trust boundaries', () => {
  it('trusts exactly IPv4 127/8, including equivalent IPv4-mapped IPv6', () => {
    fc.assert(fc.property(fc.tuple(octet, octet, octet, octet), ([a, b, c, d]) => {
      const address = `${a}.${b}.${c}.${d}`
      const mapped = `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
      for (const host of [address, `::ffff:${address}`, mapped, `[${mapped}]`]) {
        expect(isLoopbackHost(host), host).toBe(a === 127)
      }
    }), { numRuns: 2000 })
  })

  it('rejects every generated invalid port on a loopback authority', () => {
    fc.assert(fc.property(
      fc.oneof(fc.integer({ min: -2147483648, max: 0 }), fc.integer({ min: 65536, max: 2147483647 })),
      (port) => {
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
          expect(isLoopbackAuthority(`${host}:${port}`)).toBe(false)
          expect(canonicalAuthority(`${host}:${port}`)).toBe('')
          expect(parseOrigin(`http://${host}:${port}`)).toBeNull()
        }
      },
    ), { numRuns: 1000 })
  })

  it('never treats a generated DNS suffix as a loopback address', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,40}$/), (label) => {
      for (const host of [`localhost.${label}`, `127.0.0.1.${label}`, `127.${label}`]) {
        expect(isLoopbackHost(host)).toBe(false)
        expect(isLoopbackAuthority(`${host}:3000`)).toBe(false)
      }
    }), { numRuns: 1000 })
  })
})
