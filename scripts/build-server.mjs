import { build } from 'esbuild'
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// Only production dependencies stay external: they are installed from the
// registry. Everything else (our source, and any devDependency that leaks into
// the server graph) must be inlined, or a global install fails to resolve it.
const external = Object.keys(pkg.dependencies ?? {})

// The daemon is not an entry: `start` spawns the CLI with `__daemon`.
const entryPoints = {
  'server/index': resolve(root, 'server/index.ts'),
  'server/cli/cli': resolve(root, 'server/cli/cli.ts'),
}

// Chunk names carry a content hash, so a rebuild never overwrites the previous
// build's chunks, and `files: ["dist/"]` would publish every one of them.
rmSync(resolve(root, 'dist/server'), { recursive: true, force: true })

const result = await build({
  entryPoints,
  outdir: resolve(root, 'dist'),
  bundle: true,
  // Without splitting, every entry is a self-contained copy of the whole server,
  // and the CLI's top-level imports load every dependency before any command
  // runs (drizzle-orm alone takes seconds). Split, the CLI's lazy
  // `import('./commands')` calls become real chunk boundaries.
  splitting: true,
  // One level below `dist/server`, the depth `resolveDefaultClientDir` searches.
  chunkNames: 'server/chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Bundling rewrites our extensionless relative imports, which Node's ESM
  // resolver would otherwise reject outside a bundler context.
  external,
  sourcemap: false,
  minify: false,
  metafile: true,
  logLevel: 'warning',
  define: {
    // Compiled in rather than read off disk at runtime. Two callers used to
    // resolve `package.json` relative to their own module, which holds for an
    // npm install and nowhere else — most importantly in a single-file build,
    // where there is no `package.json` and the answer was a silent `0.0.0`.
    __LOOPTROOP_VERSION__: JSON.stringify(pkg.version),
    // Same reason, and one more: a floor that fell back to a placeholder would
    // make `doctor`'s node check pass on every runtime, silently.
    __LOOPTROOP_NODE_FLOOR__: JSON.stringify(pkg.engines.node),
  },
})

const outputs = Object.keys(result.metafile.outputs)
if (outputs.length === 0) {
  console.error('[build:server] esbuild produced no output.')
  process.exit(1)
}

const chunks = outputs.filter((output) => output.includes('server/chunks/'))
for (const output of outputs.filter((output) => !chunks.includes(output))) {
  console.log(`[build:server] ${output} (${(result.metafile.outputs[output].bytes / 1024).toFixed(1)} kB)`)
}
const chunkBytes = chunks.reduce((sum, output) => sum + result.metafile.outputs[output].bytes, 0)
console.log(`[build:server] dist/server/chunks/: ${chunks.length} files (${(chunkBytes / 1024).toFixed(1)} kB)`)

// Copied rather than bundled: the launcher must stay ES5 CommonJS so an old
// Node parses it and prints the version message instead of a SyntaxError.
copyFileSync(
  resolve(root, 'server/cli/launcher.cjs'),
  resolve(root, 'dist/server/cli/launcher.cjs'),
)
console.log('[build:server] dist/server/cli/launcher.cjs (copied verbatim)')
