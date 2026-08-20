import { build } from 'esbuild'
import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// Only production dependencies stay external: they are installed from the
// registry. Everything else (our source, and any devDependency that leaks into
// the server graph) must be inlined, or a global install fails to resolve it.
const external = Object.keys(pkg.dependencies ?? {})

const entryPoints = {
  'server/index': resolve(root, 'server/index.ts'),
  'server/cli/cli': resolve(root, 'server/cli/cli.ts'),
  // Spawned by `start` as the detached child, so it needs its own entry.
  'server/cli/daemonProcess': resolve(root, 'server/cli/daemonProcess.ts'),
}

const result = await build({
  entryPoints,
  outdir: resolve(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Bundling rewrites our extensionless relative imports, which Node's ESM
  // resolver would otherwise reject outside a bundler context.
  external,
  sourcemap: false,
  minify: false,
  metafile: true,
  logLevel: 'info',
  define: {
    'process.env.LOOPTROOP_BUILD': JSON.stringify('production'),
    // Compiled in rather than read off disk at runtime. Two callers used to
    // resolve `package.json` relative to their own module, which holds for an
    // npm install and nowhere else — most importantly in a single-file build,
    // where there is no `package.json` and the answer was a silent `0.0.0`.
    __LOOPTROOP_VERSION__: JSON.stringify(pkg.version),
  },
})

const outputs = Object.keys(result.metafile.outputs)
if (outputs.length === 0) {
  console.error('[build:server] esbuild produced no output.')
  process.exit(1)
}

for (const output of outputs) {
  const { bytes } = result.metafile.outputs[output]
  console.log(`[build:server] ${output} (${(bytes / 1024).toFixed(1)} kB)`)
}

// Copied rather than bundled: the launcher must stay ES5 CommonJS so an old
// Node parses it and prints the version message instead of a SyntaxError.
copyFileSync(
  resolve(root, 'server/cli/launcher.cjs'),
  resolve(root, 'dist/server/cli/launcher.cjs'),
)
console.log('[build:server] dist/server/cli/launcher.cjs (copied verbatim)')
