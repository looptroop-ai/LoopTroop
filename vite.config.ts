import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'
import { getBackendOrigin, getDocsBaseUrl, getFrontendPort } from './shared/appConfig.ts'
import { resolveDevHostMode } from './scripts/dev-host-mode.ts'
import { readPackageVersion } from './scripts/package-version.ts'
import { resolveWatchPollingDecision } from './shared/wslPerformance.ts'
import {
  DEV_SERVER_RESOURCE_HEADERS,
  FRONTEND_DEDUPED_DEPENDENCIES,
  frontendOptimizeDeps,
} from './scripts/vite-optimize-deps.ts'
import { getDevProxyOriginOverride } from './scripts/dev-api-proxy.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendOrigin = getBackendOrigin()
const apiToken = process.env.LOOPTROOP_API_TOKEN?.trim() ?? ''
const apiTokenHeader = 'X-LoopTroop-Token'
const devHostMode = resolveDevHostMode()

/**
 * The `/api` proxy, shared by `vite dev` and `vite preview`.
 *
 * It carries three jobs the browser cannot do for itself, and all three are
 * load-bearing:
 *
 * - it attaches the API token, so the page never holds a credential;
 * - `changeOrigin` rewrites Host to the backend's own authority, without which
 *   the daemon's loopback guard rejects every request that reached the frontend
 *   under any other name — a tunnel or a reverse proxy, for instance;
 * - it overrides Origin for the same guard.
 *
 * Defined once because a second copy would drift, and the drift would surface
 * as a blanket 403 with nothing to point at.
 */
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: backendOrigin,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        if (apiToken) {
          proxyReq.setHeader(apiTokenHeader, apiToken)
        }

        const originOverride = getDevProxyOriginOverride({
          origin: req.headers.origin,
          host: req.headers.host,
          secFetchSite: req.headers['sec-fetch-site'],
          backendOrigin,
        })
        if (originOverride) {
          proxyReq.setHeader('Origin', originOverride)
        }
      })
      proxy.on('error', (err, _req, res) => {
        if ('code' in err && err.code === 'ECONNREFUSED') {
          // Backend not ready yet — return 503 silently so the
          // client-side health poller can retry without noisy logs.
          if (res && 'writeHead' in res) {
            (res as ServerResponse).writeHead(503, { 'Content-Type': 'application/json' })
            ;(res as ServerResponse).end(JSON.stringify({ error: 'Backend not ready' }))
          }
          return
        }
      })
    },
  },
}

function detectWslRuntime() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true

  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

const watchPolling = resolveWatchPollingDecision({
  explicitPolling: process.env.CHOKIDAR_USEPOLLING,
  isWsl: detectWslRuntime(),
  workspacePath: __dirname,
})
console.log(`[dev-frontend] ${watchPolling.reason}`)

// Also read by scripts/generate-third-party-notices.mjs, which cannot import
// from this TypeScript config.
const BUNDLED_PACKAGES_MANIFEST = 'bundled-packages.json'

/** Extracts `@scope/name` or `name` from a resolved node_modules module id. */
function packageNameFromModuleId(id: string): string | null {  const normalized = id.replace(/\\/g, '/')
  const marker = normalized.lastIndexOf('node_modules/')
  if (marker === -1) return null

  const segments = normalized.slice(marker + 'node_modules/'.length).split('/')
  const first = segments[0]
  if (!first) return null
  const name = first.startsWith('@') ? segments.slice(0, 2).join('/') : first
  return name.length > 0 && !name.startsWith('.') ? name : null
}

/**
 * Records which npm packages rollup actually inlined into the client bundle.
 * These are devDependencies, so the production-tree licence scan cannot see
 * them even though their code is redistributed in the published assets.
 */
function bundledPackagesManifest(): import('vite').Plugin {
  return {
    name: 'looptroop-bundled-packages-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const names = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const id of chunk.moduleIds) {
          const name = packageNameFromModuleId(id)
          if (name) names.add(name)
        }
      }

      this.emitFile({
        type: 'asset',
        fileName: BUNDLED_PACKAGES_MANIFEST,
        source: `${JSON.stringify([...names].sort(), null, 2)}\n`,
      })
    },
  }
}

/** Forward slashes throughout, because that is what rollup module ids use. */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

const PROJECT_ROOT_POSIX = toPosixPath(__dirname)
const SERVER_SOURCE_ROOT_POSIX = `${toPosixPath(resolve(__dirname, 'server'))}/`

/**
 * Fails the client build if a `server/` module reaches the browser bundle.
 *
 * Seven components imported `PROFILE_DEFAULTS` from `@server/db/defaults`,
 * which pulled a database module and its transitive imports into
 * `dist/client`. Nothing caught it, because a single named export from a
 * server module compiles and runs perfectly well in the browser right up until
 * one of those imports touches `node:fs`.
 *
 * This reads rollup's module graph rather than grepping the emitted text. A
 * text search both false-positives on source-map content and package metadata,
 * and false-negatives on an import whose identifiers were renamed during
 * bundling.
 *
 * Everything is compared in posix form. Rollup normalises module ids to forward
 * slashes on every platform, while `resolve()` returns the host's separators —
 * so on Windows a raw comparison matches nothing at all and the guard passes
 * silently, which is the one failure mode a fail-closed check must not have.
 */
/** The repo-relative path of a `server/` module, or null for anything else. */
function serverModuleOffender(moduleId: string): string | null {
  if (moduleId.includes('node_modules')) return null
  const path = toPosixPath(moduleId.split('?')[0] ?? moduleId)
  if (!path.startsWith(SERVER_SOURCE_ROOT_POSIX)) return null
  return path.startsWith(`${PROJECT_ROOT_POSIX}/`) ? path.slice(PROJECT_ROOT_POSIX.length + 1) : path
}

/** Deterministic on every machine, unlike `localeCompare`. */
function byPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function noServerModulesInClientBundle(): import('vite').Plugin {
  return {
    name: 'looptroop-no-server-modules-in-client-bundle',
    apply: 'build',
    generateBundle(_options, bundle) {
      const offenders = new Set<string>()

      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const id of chunk.moduleIds) {
          const offender = serverModuleOffender(id)
          if (offender) offenders.add(offender)
        }
      }

      if (offenders.size === 0) return

      this.error(
        `The client bundle pulls in ${offenders.size} server module(s):\n`
        + [...offenders].sort(byPath).map((path) => `  - ${path}`).join('\n')
        + '\n\nMove what both sides need into shared/ and import it from there.',
      )
    },
  }
}

/**
 * Fails the client build if the root `package.json` reaches the browser bundle.
 *
 * `AppShell` imported the whole manifest to render one version string, so every
 * script, devDependency and engines entry shipped to the browser. The version is
 * now compiled in as `__APP_VERSION__`, and this is what keeps it that way — the
 * import type-checks, bundles and runs, so nothing else would notice.
 *
 * Module-graph rather than text search, and posix-normalised, for the reasons
 * given on the server-module guard above.
 */
const ROOT_MANIFEST_POSIX = `${PROJECT_ROOT_POSIX}/package.json`

function noRootManifestInClientBundle(): import('vite').Plugin {
  return {
    name: 'looptroop-no-root-manifest-in-client-bundle',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const id of chunk.moduleIds) {
          if (id.includes('node_modules')) continue
          if (toPosixPath(id.split('?')[0] ?? id) !== ROOT_MANIFEST_POSIX) continue
          this.error(
            'The client bundle pulls in the root package.json, which ships every '
            + 'script, devDependency and engines entry to the browser.\n\n'
            + 'Use the __APP_VERSION__ define instead of importing the manifest.',
          )
        }
      }
    },
  }
}

function isBackendHealthProbe(req: IncomingMessage) {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false
  if (!req.url) return false
  const url = new URL(req.url, 'http://localhost')
  return url.pathname === '/api/health'
}

async function respondToBackendHealthProbe(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/api/health', backendOrigin)

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiToken ? { [apiTokenHeader]: apiToken } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    })

    res.statusCode = response.status
    const contentType = response.headers.get('content-type')
    if (contentType) {
      res.setHeader('Content-Type', contentType)
    }

    res.end(await response.text())
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Backend not ready' }))
  }
}

export default defineConfig({
  define: {
    __LOOPTROOP_DEV_BACKEND_ORIGIN__: JSON.stringify(backendOrigin),
    __LOOPTROOP_DOCS_ORIGIN__: JSON.stringify(getDocsBaseUrl()),
    // The version alone, compiled in. `AppShell` imported the whole root
    // `package.json` to read it, which pulled every script, devDependency and
    // engines entry into `dist/client`.
    __APP_VERSION__: JSON.stringify(readPackageVersion()),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'looptroop-dev-health-probe',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!isBackendHealthProbe(req)) {
            next()
            return
          }

          void respondToBackendHealthProbe(req, res)
        })
      },
    },
    bundledPackagesManifest(),
    noServerModulesInClientBundle(),
    noRootManifestInClientBundle(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@server': resolve(__dirname, './server'),
      '@shared': resolve(__dirname, './shared'),
    },
    dedupe: [...FRONTEND_DEDUPED_DEPENDENCIES],
  },
  optimizeDeps: frontendOptimizeDeps,
  build: {
    // Kept out of dist/ root so emptyOutDir cannot wipe the server bundle.
    outDir: 'dist/client',
    sourcemap: false,
    chunkSizeWarningLimit: 2100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/')) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/@radix-ui/')) {
            return 'vendor-radix'
          }
          if (id.includes('node_modules/@codemirror/')) {
            return 'vendor-codemirror'
          }
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'vendor-query'
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons'
          }
          if (id.includes('node_modules/gpt-tokenizer')) {
            return 'vendor-tokenizer'
          }
        },
      },
    },
  },
  appType: 'spa',
  server: {
    headers: DEV_SERVER_RESOURCE_HEADERS,
    host: devHostMode.enabled ? devHostMode.bindHost : undefined,
    port: getFrontendPort(),
    strictPort: true,
    warmup: {
      clientFiles: [
        './src/components/ticket/TicketDashboard.tsx',
        './src/components/ticket/ActiveWorkspace.tsx',
        './src/components/workspace/PhaseReviewView.tsx',
        './src/components/workspace/CollapsiblePhaseLogSection.tsx',
        './src/components/workspace/PhaseLogPanel.tsx',
      ],
    },
    watch: {
      usePolling: watchPolling.usePolling,
    },
    proxy: apiProxy,
  },
  // `vite preview` serves the built bundle, and it needs the same proxy for one
  // reason that is easy to miss: the proxy is not a routing convenience, it is
  // what authenticates the browser. Without it `preview` serves a working page
  // whose every request is rejected, which is worse than not running at all.
  preview: {
    headers: DEV_SERVER_RESOURCE_HEADERS,
    host: devHostMode.enabled ? devHostMode.bindHost : undefined,
    port: getFrontendPort(),
    strictPort: true,
    proxy: apiProxy,
  },
})
