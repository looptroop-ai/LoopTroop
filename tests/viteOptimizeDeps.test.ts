import { Node, Project, SyntaxKind } from 'ts-morph'
import { readFileSync } from 'node:fs'
import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  DEV_SERVER_RESOURCE_HEADERS,
  FRONTEND_DEDUPED_DEPENDENCIES,
  FRONTEND_OPTIMIZED_DEPENDENCIES,
  frontendOptimizeDeps,
} from '../scripts/vite-optimize-deps'

const GENERATED_REACT_RUNTIME_IMPORTS = [
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
] as const

function isProductionSource(filePath: string): boolean {
  return !filePath.includes('/__tests__/')
    && !filePath.includes('/src/test/')
    && !/\.(?:test|spec)\.[^.]+$/.test(filePath)
}

function isBrowserBareImport(specifier: string): boolean {
  return !specifier.startsWith('.')
    && !specifier.startsWith('@/')
    && !specifier.startsWith('@server/')
    && !specifier.startsWith('@shared/')
    && !specifier.startsWith('node:')
}

function collectBrowserBareImports(): string[] {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
    skipAddingFilesFromTsConfig: true,
  })
  project.addSourceFilesAtPaths(['src/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'])

  const imports = new Set<string>(GENERATED_REACT_RUNTIME_IMPORTS)
  for (const sourceFile of project.getSourceFiles().filter((file) => isProductionSource(file.getFilePath()))) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (!declaration.isTypeOnly()) imports.add(declaration.getModuleSpecifierValue())
    }

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue
      const argument = call.getArguments()[0]
      // `Node.isStringLiteral` rather than comparing kinds: the kind check does
      // not narrow, so `getLiteralText` is not on the node's type afterwards.
      if (argument && Node.isStringLiteral(argument)) imports.add(argument.getLiteralText())
    }
  }

  return [...imports].filter(isBrowserBareImport).sort()
}

describe('Vite dependency optimization policy', () => {
  it('restricts built pages to same-origin connections while retaining development HMR', async () => {
    const html = readFileSync('index.html', 'utf8')
    const production = await resolveConfig({}, 'build')
    const development = await resolveConfig({}, 'serve')
    const name = 'looptroop-production-csp'
    expect(development.plugins.some((plugin) => plugin.name === name)).toBe(false)
    expect(html).toContain("connect-src 'self' ws:;")
    const transform = production.plugins.find((plugin) => plugin.name === name)?.transformIndexHtml
    expect(typeof transform).toBe('function')
    if (typeof transform !== 'function') throw new Error('Missing production CSP transform')
    const built = await Reflect.apply(transform, undefined, [html, { path: '/index.html', filename: 'index.html' }])
    expect(built).toContain("connect-src 'self';")
    expect(built).not.toContain("connect-src 'self' ws:;")
    expect(built).toContain("style-src 'self' 'unsafe-inline'; script-src 'self';")
  })

  it('disables late discovery and declares every production browser dependency', () => {
    expect(frontendOptimizeDeps.noDiscovery).toBe(true)
    expect([...FRONTEND_OPTIMIZED_DEPENDENCIES].sort()).toEqual(collectBrowserBareImports())
    expect(frontendOptimizeDeps.include).toEqual([...FRONTEND_OPTIMIZED_DEPENDENCIES])
  }, 30000)

  it('prevents restored dev pages from reusing an old React dependency graph', () => {
    expect(DEV_SERVER_RESOURCE_HEADERS).toEqual({ 'Cache-Control': 'no-store' })
    expect(FRONTEND_DEDUPED_DEPENDENCIES).toEqual(expect.arrayContaining([
      'react',
      'react-dom',
      '@tanstack/react-query',
      '@tanstack/query-core',
    ]))
  })
})
