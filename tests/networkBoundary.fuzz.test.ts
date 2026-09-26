import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from '../shared/appConfig'
import { canonicalAuthority, isLoopbackAuthority, parseOrigin } from '../server/middleware/hostGuard'

const octet = fc.integer({ min: 0, max: 255 })

// Bind hosts and HTTP Host/Origin must agree on literal loopback addresses;
// URL normalization must not promote alternate IPv4 spellings into trust.
// Keep randomized exploration: fast-check reports the seed and path on failure.
describe('generated network trust boundaries', () => {
  it('trusts exactly IPv4 127/8, including equivalent IPv4-mapped IPv6', () => {
    fc.assert(fc.property(fc.tuple(octet, octet, octet, octet), ([a, b, c, d]) => {
      const address = `${a}.${b}.${c}.${d}`
      const mapped = `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
      for (const host of [address, `::ffff:${address}`, `[::ffff:${address}]`, mapped, `[${mapped}]`]) {
        expect(isLoopbackHost(host), host).toBe(a === 127)
      }
    }), { numRuns: 2000 })
  })

  it('recognizes only literal loopback among extended IPv4 spellings', () => {
    fc.assert(fc.property(fc.ipV4Extended(), (host) => {
      const canonical = new URL(`http://${host}`).hostname
      const literal = canonical === host
      expect(isLoopbackHost(host), host).toBe(literal && canonical.startsWith('127.'))
      expect(isLoopbackAuthority(`${host}:3000`), host).toBe(isLoopbackHost(host))
      expect(parseOrigin(`http://${host}:3000`) !== null, host).toBe(literal)
    }), { numRuns: 2000 })
  })

  it('recognizes the loopback ranges across generated IPv6 representations', () => {
    fc.assert(fc.property(fc.ipV6(), (host) => {
      const canonical = new URL(`http://[${host}]`).hostname
      const loopback = canonical === '[::1]' || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(canonical)
      for (const spelling of [host, host.toUpperCase(), `[${host}]`]) {
        expect(isLoopbackHost(spelling), spelling).toBe(loopback)
      }
      expect(isLoopbackAuthority(`[${host}]:3000`), host).toBe(loopback)
      expect(canonicalAuthority(`[${host}]:3000`)).toBe(parseOrigin(`http://[${host}]:3000`)?.authority)
    }), { numRuns: 2000 })
  })

  it.each([
    ['LOCALHOST', true], ['LocalHost', true], ['localhost.', false], ['127.0.0.1.', false],
    ['::1', true], ['[::1]', true], ['0:0:0:0:0:0:0:1', true], ['[0:0:0:0:0:0:0:1]', true],
    ['[::1%25eth0]', false], ['::ffff:127.0.0.1%eth0', false],
    ['0177.0.0.1', false], ['127.000.000.001', false], ['0x7f.0.0.1', false],
    ['2130706433', false], ['127.1', false],
  ])('keeps loopback trust stable for %s', (host, trusted) => {
    expect(isLoopbackHost(host)).toBe(trusted)
    expect(isLoopbackAuthority(host)).toBe(trusted)
  })

  it.each(['', '80', '0080', '0000000080', '0000', '+80', ' 80', '0x50', '65536', '0', '-1', '99999'])(
    'keeps Host and Origin port normalization aligned for "%s"', (port) => {
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        for (const [scheme, defaultPort] of [['http', '80'], ['https', '443']]) {
          expect(canonicalAuthority(`${host}:${port}`, defaultPort))
            .toBe(parseOrigin(`${scheme}://${host}:${port}`)?.authority ?? '')
        }
      }
    },
  )

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
