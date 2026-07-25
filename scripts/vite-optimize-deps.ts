import type { DepOptimizationOptions } from 'vite'

/**
 * Browser runtime dependencies that Vite must optimize before accepting dev
 * requests. Keep this list synchronized with production imports under src/ and
 * shared/; tests enforce that invariant.
 */
export const FRONTEND_OPTIMIZED_DEPENDENCIES = [
  '@codemirror/autocomplete',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/state',
  '@codemirror/view',
  '@radix-ui/react-dialog',
  '@radix-ui/react-dropdown-menu',
  '@radix-ui/react-hover-card',
  '@radix-ui/react-scroll-area',
  '@radix-ui/react-separator',
  '@radix-ui/react-slot',
  '@radix-ui/react-tooltip',
  '@tanstack/react-query',
  'class-variance-authority',
  'clsx',
  'gpt-tokenizer',
  'js-yaml',
  'lucide-react',
  'react',
  'react-dom',
  'react-dom/client',
  'react-virtuoso',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'tailwind-merge',
  'zod',
] as const

export const FRONTEND_DEDUPED_DEPENDENCIES = [
  'react',
  'react-dom',
  '@tanstack/react-query',
  '@tanstack/query-core',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
] as const

export const DEV_SERVER_RESOURCE_HEADERS = {
  // Optimized deps are immutable by default. That can restore an old React
  // graph after the dev server has generated a new dependency cache.
  'Cache-Control': 'no-store',
} as const

export const frontendOptimizeDeps = {
  // Vite's discovery crawl can finish after the first browser request. An
  // explicit set makes startup wait for one stable dependency generation.
  noDiscovery: true,
  include: [...FRONTEND_OPTIMIZED_DEPENDENCIES],
} satisfies DepOptimizationOptions
