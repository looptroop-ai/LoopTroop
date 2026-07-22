import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'
import { getBackendOrigin, getDocsBaseUrl, getFrontendPort } from './shared/appConfig'
import { resolveDevHostMode } from './scripts/dev-host-mode'
import {
  DEV_SERVER_RESOURCE_HEADERS,
  FRONTEND_DEDUPED_DEPENDENCIES,
  frontendOptimizeDeps,
} from './scripts/vite-optimize-deps'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendOrigin = getBackendOrigin()
const apiToken = process.env.LOOPTROOP_API_TOKEN?.trim() ?? ''
const apiTokenHeader = 'X-LoopTroop-Token'
const devHostMode = resolveDevHostMode()

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
      usePolling: true,
    },
    proxy: {
      '/api': {
        target: backendOrigin,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (apiToken) {
              proxyReq.setHeader(apiTokenHeader, apiToken)
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
