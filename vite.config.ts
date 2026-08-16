import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'
import { getBackendOrigin, getDocsBaseUrl, getFrontendPort } from './shared/appConfig'
import { resolveDevHostMode } from './scripts/dev-host-mode'
import { resolveWatchPollingDecision } from './shared/wslPerformance'
import {
  DEV_SERVER_RESOURCE_HEADERS,
  FRONTEND_DEDUPED_DEPENDENCIES,
  frontendOptimizeDeps,
} from './scripts/vite-optimize-deps'
import { getDevProxyOriginOverride } from './scripts/dev-api-proxy'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendOrigin = getBackendOrigin()
const apiToken = process.env.LOOPTROOP_API_TOKEN?.trim() ?? ''
const apiTokenHeader = 'X-LoopTroop-Token'
const devHostMode = resolveDevHostMode()

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
    proxy: {
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
                (res as import('http').ServerResponse).writeHead(503, { 'Content-Type': 'application/json' })
                ;(res as import('http').ServerResponse).end(JSON.stringify({ error: 'Backend not ready' }))
              }
              return
            }
          })
        },
      },
    },
  },
})
