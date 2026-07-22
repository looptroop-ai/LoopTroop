import { BACKEND_HEALTH_TIMEOUT_MS } from '@/lib/constants'

const DEV_BACKEND_HEALTH_PATH = '/api/health'
const DEV_BACKEND_POLL_MS = 250
const DEV_BACKEND_TIMEOUT_MS = 30_000
const API_TOKEN_HEADER = 'X-LoopTroop-Token'

const nativeFetch = (() => {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return window.fetch.bind(window)
  }

  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }

  throw new Error('Global fetch is not available')
})()

let devApiGuardInstalled = false
let pendingBackendReadyCheck: Promise<void> | null = null

function isDevelopmentRuntime() {
  return typeof window !== 'undefined' && import.meta.env.MODE === 'development'
}

function getAbortError() {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : new Error('The operation was aborted.')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : getAbortError()
  }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function resolveUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return new URL(input, window.location.origin)
  if (input instanceof URL) return input
  if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url, window.location.origin)
  return null
}

function isFrontendApiUrl(url: URL) {
  return url.origin === window.location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'))
}

function getDevReadyProbeUrl(path: string) {
  return new URL(path, __LOOPTROOP_DEV_BACKEND_ORIGIN__).toString()
}

function getApiToken(): string {
  // The API token is intentionally not baked into the client bundle.
  // During local development, the Vite proxy injects it server-side.
  return ''
}

function withApiTokenHeader(init?: RequestInit): RequestInit | undefined {
  const token = getApiToken()
  if (!token) return init

  const headers = new Headers(init?.headers)
  if (!headers.has(API_TOKEN_HEADER) && !headers.has('Authorization')) {
    headers.set(API_TOKEN_HEADER, token)
  }
  return { ...init, headers }
}

function appendApiTokenQuery(url: URL): URL {
  const token = getApiToken()
  if (token && (url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
    url.searchParams.set('apiToken', token)
  }
  return url
}

export async function pingDevBackend() {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), BACKEND_HEALTH_TIMEOUT_MS)

  try {
    // Use same-origin path through the Vite proxy to avoid cross-origin CORS/PNA issues.
    // nativeFetch bypasses devApiGuard to prevent recursion.
    const response = await nativeFetch(DEV_BACKEND_HEALTH_PATH, withApiTokenHeader({
      cache: 'no-store',
      signal: controller.signal,
    }))
    // A rate-limit response still proves that the backend and Vite proxy are reachable.
    // Treating it as downtime starts a readiness-probe storm and can mask the real 429.
    return response.ok || response.status === 429
  } catch {
    return false
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function pollDevBackendUntilReady() {
  const startedAt = Date.now()

  while (Date.now() - startedAt < DEV_BACKEND_TIMEOUT_MS) {
    if (await pingDevBackend()) return
    await sleep(DEV_BACKEND_POLL_MS)
  }

  throw new Error(`LoopTroop backend did not become ready within ${DEV_BACKEND_TIMEOUT_MS / 1000}s`)
}

function waitForSignal(signal?: AbortSignal) {
  if (!signal) return null

  let dispose: () => void = () => {}

  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : getAbortError())
    }

    dispose = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return { promise, dispose }
}

export async function waitForDevBackend(signal?: AbortSignal) {
  if (!isDevelopmentRuntime()) return

  throwIfAborted(signal)

  if (!pendingBackendReadyCheck) {
    pendingBackendReadyCheck = pollDevBackendUntilReady().finally(() => {
      pendingBackendReadyCheck = null
    })
  }

  const abortState = waitForSignal(signal)
  if (!abortState) {
    await pendingBackendReadyCheck
    return
  }

  try {
    await Promise.race([pendingBackendReadyCheck, abortState.promise])
  } finally {
    abortState.dispose()
  }
}

export function getApiUrl(path: string, options?: { directInDevelopment?: boolean }) {
  if (typeof window === 'undefined') return path

  if (isDevelopmentRuntime() && options?.directInDevelopment) {
    return appendApiTokenQuery(new URL(getDevReadyProbeUrl(path))).toString()
  }

  return appendApiTokenQuery(new URL(path, window.location.origin)).toString()
}

export const __devApiForTests = {
  getDevReadyProbeUrl,
  appendApiTokenQuery,
}

export function installDevApiGuard() {
  if (devApiGuardInstalled) return
  if (!isDevelopmentRuntime() && !getApiToken()) return

  const originalFetch = nativeFetch

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const resolvedUrl = resolveUrl(input)
    if (!resolvedUrl || !isFrontendApiUrl(resolvedUrl)) {
      return originalFetch(input, init)
    }

    if (isDevelopmentRuntime()) {
      await waitForDevBackend(init?.signal ?? undefined)
    }

    return originalFetch(input, withApiTokenHeader(init))
  }

  devApiGuardInstalled = true
}
