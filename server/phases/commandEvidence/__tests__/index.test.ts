import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findCommandLauncher,
  validateRepositoryCommand,
  type CommandEvidenceAdapter,
} from '..'

const roots: string[] = []

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-command-evidence-'))
  roots.push(root)
  return root
}

function file(root: string, path: string, content = ''): void {
  const absolutePath = join(root, path)
  mkdirSync(join(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('validateRepositoryCommand', () => {
  it('rejects an npm task in a Go-only repository even when npm is globally available', () => {
    const root = repository()
    file(root, 'go.mod', 'module example.com/project\n\ngo 1.24\n')

    const result = validateRepositoryCommand({ repositoryRoot: root, command: 'npm test' })

    expect(result).toMatchObject({
      valid: false,
      status: 'incompatible',
      family: 'node',
      code: 'missing-project-evidence',
    })
    expect(result.message).toContain('package.json')
  })

  it('accepts a declared Node task and rejects an absent one', () => {
    const root = repository()
    file(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))

    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'npm test' })).toMatchObject({
      valid: true,
      family: 'node',
    })
    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'npm run lint' })).toMatchObject({
      valid: false,
      code: 'missing-task',
    })
  })

  it('allows package installation only when validating a setup step', () => {
    const root = repository()
    file(root, 'package.json', JSON.stringify({ scripts: {} }))

    expect(validateRepositoryCommand({
      repositoryRoot: root,
      command: 'corepack npm ci',
      commandKind: 'setup-step',
    })).toMatchObject({ valid: true, family: 'node' })
    expect(validateRepositoryCommand({
      repositoryRoot: root,
      command: 'npm ci',
      commandKind: 'bead-test',
    })).toMatchObject({ valid: false, code: 'missing-task' })
  })

  it('accepts Go commands from repository evidence even when the launcher may be off PATH', () => {
    const root = repository()
    file(root, 'go.mod', 'module example.com/project\n')

    const result = validateRepositoryCommand({ repositoryRoot: root, command: 'go test ./...' })

    expect(result.valid).toBe(true)
    expect(result.family).toBe('go')
    expect(result.evidence[0]?.path).toBe('go.mod')
    expect(['ready', 'launcher-missing']).toContain(result.status)
  })

  it('unwraps environment assignments, canonical wrapper, and cd prefixes', () => {
    const root = repository()
    file(root, 'services/api/go.mod', 'module example.com/api\n')

    const result = validateRepositoryCommand({
      repositoryRoot: root,
      command: 'cd services/api && CGO_ENABLED=0 ./.ticket/runtime/execution-setup/run go test ./...',
    })

    expect(result).toMatchObject({
      valid: true,
      family: 'go',
      wrapperApplied: true,
      executable: 'go',
    })
    expect(result.effectiveWorkingDirectory).toBe(join(root, 'services/api'))
    expect(result.launcher.executable).toBe('./.ticket/runtime/execution-setup/run')
  })

  it('rejects ambiguous shell programs instead of guessing their effective command', () => {
    const root = repository()
    file(root, 'go.mod')

    for (const command of ['go test ./... | tee result.txt', 'go test; npm test', 'go test $(cat args)']) {
      expect(validateRepositoryCommand({ repositoryRoot: root, command })).toMatchObject({
        valid: false,
        code: 'unsupported-shell-syntax',
      })
    }
  })

  it('accepts repository-local executable and interpreter-invoked task scripts', () => {
    const root = repository()
    file(root, 'scripts/check', '#!/bin/sh\nexit 0\n')
    chmodSync(join(root, 'scripts/check'), 0o755)
    file(root, 'scripts/check.sh', 'exit 0\n')
    file(root, 'check.js', 'process.exit(0)\n')

    expect(validateRepositoryCommand({ repositoryRoot: root, command: './scripts/check' })).toMatchObject({
      valid: true,
      family: 'repository-local',
    })
    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'sh scripts/check.sh' })).toMatchObject({
      valid: true,
      family: 'repository-local',
    })
    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'node check.js' })).toMatchObject({
      valid: true,
      family: 'repository-local',
    })
  })

  it('rejects missing and non-executable repository-local commands', () => {
    const root = repository()
    file(root, 'scripts/check', '#!/bin/sh\n')

    expect(validateRepositoryCommand({ repositoryRoot: root, command: './scripts/missing' })).toMatchObject({
      valid: false,
      code: 'missing-project-evidence',
    })
    expect(validateRepositoryCommand({ repositoryRoot: root, command: './scripts/check' })).toMatchObject({
      valid: false,
      code: 'missing-project-evidence',
    })
  })

  it('validates Make targets rather than accepting any invented task', () => {
    const root = repository()
    file(root, 'Makefile', 'test:\n\t@echo ok\n')

    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'make test' }).valid).toBe(true)
    expect(validateRepositoryCommand({ repositoryRoot: root, command: 'make deploy' })).toMatchObject({
      valid: false,
      code: 'missing-task',
    })
  })

  it.each([
    ['cargo test', 'Cargo.toml', '[package]\nname = "sample"\nversion = "0.1.0"\n'],
    ['pytest', 'pyproject.toml', '[project]\nname = "sample"\n'],
    ['mvn test', 'pom.xml', '<project/>'],
    ['gradle test', 'build.gradle', 'plugins {}'],
    ['dotnet test', 'sample.csproj', '<Project/>'],
    ['bundle exec rspec', 'Gemfile', 'source "https://rubygems.org"'],
    ['composer test', 'composer.json', '{"scripts":{"test":"phpunit"}}'],
    ['cmake --build build', 'CMakeLists.txt', 'project(sample)'],
  ])('recognizes %s from %s', (command, manifest, content) => {
    const root = repository()
    file(root, manifest, content)

    expect(validateRepositoryCommand({ repositoryRoot: root, command }).valid).toBe(true)
  })

  it('accepts explicitly justified planned manifests and tasks', () => {
    const root = repository()

    const result = validateRepositoryCommand({
      repositoryRoot: root,
      command: 'npm run generated:test',
      plannedEvidence: [{
        path: 'package.json',
        source: 'dependency bead B-001',
        commandFamilies: ['node'],
        tasks: ['generated:test'],
      }],
    })

    expect(result).toMatchObject({ valid: true, family: 'node' })
    expect(result.evidence[0]).toMatchObject({ kind: 'planned', path: 'package.json' })
  })

  it('supports additional command families through the adapter registry', () => {
    const root = repository()
    file(root, 'Project.task')
    const adapter: CommandEvidenceAdapter = {
      id: 'example',
      executables: ['project-tool'],
      validate(context) {
        const manifest = context.evidence.findUp(['Project.task'], context.workingDirectory)
        return manifest
          ? { valid: true, evidence: [{ kind: 'manifest', path: manifest.relativePath, detail: 'example task file' }] }
          : { valid: false, code: 'missing-project-evidence' }
      },
    }

    expect(validateRepositoryCommand({
      repositoryRoot: root,
      command: 'project-tool verify',
      adapters: [adapter],
    })).toMatchObject({
      valid: true,
      family: 'example',
      status: 'launcher-missing',
    })
  })

  it('rejects unknown bare commands with actionable expected evidence', () => {
    const root = repository()

    const result = validateRepositoryCommand({ repositoryRoot: root, command: 'mystery verify' })

    expect(result).toMatchObject({ valid: false, code: 'unknown-command-family' })
    expect(result.expectedEvidence).toContain('a registered command-evidence adapter')
  })
})

describe('findCommandLauncher', () => {
  it('uses PATHEXT when checking Windows launchers', () => {
    const root = repository()
    file(root, 'project-tool.CMD', '@exit /b 0\r\n')

    expect(findCommandLauncher('project-tool', {
      workingDirectory: root,
      platform: 'win32',
      env: { PATH: root, PATHEXT: '.EXE;.CMD' },
    })).toMatchObject({
      availability: 'available',
      resolvedPath: join(root, 'project-tool.CMD'),
    })
  })
})
