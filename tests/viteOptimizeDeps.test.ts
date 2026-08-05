import { Project, SyntaxKind } from 'ts-morph'
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
      if (argument?.getKind() === SyntaxKind.StringLiteral) imports.add(argument.getLiteralText())
    }
  }

  return [...imports].filter(isBrowserBareImport).sort()
}

describe('Vite dependency optimization policy', () => {
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
