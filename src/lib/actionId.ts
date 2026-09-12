/** Returns an opaque cryptographic ID: a native UUID or 32 hex characters on HTTP LAN origins. */
export function createActionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Web Crypto is unavailable; cannot create an action ID')
  }
  // HTTP LAN origins expose getRandomValues, but not randomUUID.
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
