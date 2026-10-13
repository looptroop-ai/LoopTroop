import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// Only production dependencies stay external: they are installed from the
// registry. Everything else (our source, and any devDependency that leaks into
// the server graph) must be inlined, or a global install fails to resolve it.
const external = Object.keys(pkg.dependencies ?? {})

const common = {
  outdir: resolve(root, 'dist'),
  // Written below, once both builds have succeeded, so a failed build leaves the
  // previous output in place.
  write: false,
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
}

// The long-running entries are self-contained files. An upgrade replaces
// `dist/` underneath a daemon that is still running, and a split daemon would
// then fail on its first lazy `import()` of a chunk the upgrade deleted (the
// adapter loads `contextBuilder` and ticket storage that way).
const longRunning = await build({
  ...common,
  entryPoints: {
    'server/index': resolve(root, 'server/index.ts'),
    'server/cli/daemonProcess': resolve(root, 'server/cli/daemonProcess.ts'),
  },
})

// The CLI is short-lived, so it is split: its lazy `import('./commands')` calls
// become real chunk boundaries and `--version` no longer loads every dependency
// (drizzle-orm alone takes seconds). The daemon it starts is the self-contained
// file above, reached by the same relative path from `cli/` and `chunks/`.
const daemonFile = {
  name: 'daemon-file',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/daemonProcess$/ }, () => ({ path: '../cli/daemonProcess.js', external: true }))
  },
}
const cli = await build({
  ...common,
  entryPoints: { 'server/cli/cli': resolve(root, 'server/cli/cli.ts') },
  splitting: true,
  // A sibling of `dist/server/cli`, so `../cli/daemonProcess.js` resolves the
  // same from the entry and from a chunk.
  chunkNames: 'server/chunks/[name]-[hash]',
  plugins: [daemonFile],
})

// The plugin is the only thing keeping the daemon out of the split build, and
// a renamed module would make it match nothing without any error.
if (Object.keys(cli.metafile.inputs).some((input) => input.endsWith('server/cli/daemonProcess.ts'))) {
  console.error('[build:server] daemonProcess.ts was bundled into the split CLI build; the daemon must stay self-contained.')
  process.exit(1)
}

const outputFiles = [...longRunning.outputFiles, ...cli.outputFiles]
if (outputFiles.length === 0) {
  console.error('[build:server] esbuild produced no output.')
  process.exit(1)
}

// Chunk names carry a content hash, so a rebuild never overwrites the previous
// build's chunks, and `files: ["dist/"]` would publish every one of them.
rmSync(resolve(root, 'dist/server'), { recursive: true, force: true })
for (const file of outputFiles) {
  mkdirSync(dirname(file.path), { recursive: true })
  writeFileSync(file.path, file.contents)
}

const outputs = { ...longRunning.metafile.outputs, ...cli.metafile.outputs }
const chunks = Object.keys(outputs).filter((output) => output.includes('server/chunks/'))
for (const output of Object.keys(outputs).filter((output) => !chunks.includes(output))) {
  console.log(`[build:server] ${output} (${(outputs[output].bytes / 1024).toFixed(1)} kB)`)
}
const chunkBytes = chunks.reduce((sum, output) => sum + outputs[output].bytes, 0)
console.log(`[build:server] dist/server/chunks/: ${chunks.length} files (${(chunkBytes / 1024).toFixed(1)} kB)`)

// Copied rather than bundled: the launcher must stay ES5 CommonJS so an old
// Node parses it and prints the version message instead of a SyntaxError.
copyFileSync(
  resolve(root, 'server/cli/launcher.cjs'),
  resolve(root, 'dist/server/cli/launcher.cjs'),
)
console.log('[build:server] dist/server/cli/launcher.cjs (copied verbatim)')
