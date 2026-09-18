import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { inspectDoctorInstall } from '../scripts/smoke-lib.mjs'

const expected = {
  chocolatey: 'choco upgrade looptroop',
  winget: 'winget upgrade LoopTroopAI.LoopTroop',
  aur: 'yay -Syu looptroop-bin   (or your AUR helper of choice)',
  container: 'docker pull looptroopai/looptroop:latest',
  binary: 'curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
} as const

const binaryWindowsUpgrade = '$script = curl.exe --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install.ps1; if ($LASTEXITCODE -ne 0 -or !$script) { throw "Installer download failed" }; & ([scriptblock]::Create(($script -join "`n"))) -Binary'

const wiringContracts = [
  {
    file: 'scripts/smoke-choco.ts',
    calls: 1,
    channel: 'chocolatey',
    upgrades: [expected.chocolatey],
    targets: ['inspection'],
  },
  {
    file: 'scripts/smoke-winget.ts',
    calls: 1,
    channel: 'winget',
    upgrades: [expected.winget],
    targets: ['inspection'],
  },
  {
    file: 'scripts/smoke-aur.ts',
    calls: 1,
    channel: 'aur',
    upgrades: [expected.aur],
    targets: ['inspection'],
  },
  {
    file: 'scripts/smoke-binary-install.mjs',
    calls: 1,
    channel: 'binary',
    upgrades: [expected.binary, binaryWindowsUpgrade],
    targets: ['inspection'],
  },
  {
    file: 'scripts/smoke-container.mjs',
    calls: 3,
    channel: 'container',
    upgrades: [expected.container],
    targets: ['inspection', 'againInspection', 'redirectedInspection'],
  },
] as const

function report(channel: string, upgradeCommand: string, detail = `${channel} (upgrade: ${upgradeCommand})`): string {
  return JSON.stringify({ checks: [{ name: 'install', detail, install: { channel, upgradeCommand } }] })
}

function parseSource(file: string) {
  const filePath = join(process.cwd(), file)
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
}

function collectNodes(source: ts.SourceFile) {
  const calls: ts.CallExpression[] = []
  const properties: ts.PropertyAccessExpression[] = []

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'inspectDoctorInstall'
    ) {
      calls.push(node)
    }
    if (ts.isPropertyAccessExpression(node)) properties.push(node)
    ts.forEachChild(node, visit)
  }

  visit(source)
  return { calls, properties }
}

function stringLiterals(node: ts.Node) {
  const values: string[] = []

  function visit(child: ts.Node) {
    if (ts.isStringLiteralLike(child)) values.push(child.text)
    ts.forEachChild(child, visit)
  }

  visit(node)
  return values
}

function rootIdentifier(node: ts.Expression) {
  let current: ts.Expression = node
  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression
    } else if (ts.isElementAccessExpression(current)) {
      current = current.expression
    } else if (ts.isCallExpression(current)) {
      current = current.expression
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression
    } else {
      return ts.isIdentifier(current) ? current.text : null
    }
  }
}

function assignedName(call: ts.CallExpression) {
  let current: ts.Node = call
  while (current.parent) {
    const parent = current.parent
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(parent.left)
    ) {
      return parent.left.text
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text
    }
    current = parent
  }
  return null
}

function importsSharedInspector(source: ts.SourceFile) {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== './smoke-lib.mjs'
    ) {
      return false
    }
    const bindings = statement.importClause?.namedBindings
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === 'inspectDoctorInstall')
    )
  })
}

function hasDoctorDetailRead(property: ts.PropertyAccessExpression) {
  if (property.name.text !== 'detail') return false
  const root = rootIdentifier(property.expression)
  return root !== null && new Set([
    'checks',
    'install',
    'check',
    'inspection',
    'againInspection',
    'redirectedInspection',
  ]).has(root)
}

describe('doctor install facts consumed by package smokes', () => {
  it('recognizes every managed smoke channel from structured facts', () => {
    for (const [channel, upgradeCommand] of Object.entries(expected)) {
      expect(inspectDoctorInstall(report(channel, upgradeCommand), { channel, upgradeCommand }).matches)
        .toBe(true)
    }
    expect(inspectDoctorInstall(report('binary', binaryWindowsUpgrade), {
      channel: 'binary',
      upgradeCommand: binaryWindowsUpgrade,
    }).matches).toBe(true)
  })

  it('ignores detail prose while preserving exact structured classification', () => {
    for (const [channel, upgradeCommand] of Object.entries(expected)) {
      expect(inspectDoctorInstall(report(channel, upgradeCommand, 'rewritten for humans'), { channel, upgradeCommand }).matches)
        .toBe(true)
    }
  })

  it('rejects wrong channel and upgrade facts for every consumer', () => {
    for (const [channel, upgradeCommand] of Object.entries(expected)) {
      expect(inspectDoctorInstall(report('npm', upgradeCommand), { channel, upgradeCommand }).matches)
        .toBe(channel === 'npm')
      expect(inspectDoctorInstall(report(channel, 'npm install -g looptroop@latest'), { channel, upgradeCommand }).matches)
        .toBe(false)
    }
  })

  it('reports container channel and upgrade-command mismatches separately', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/smoke-container.mjs'), 'utf8')
    expect(source).toContain("check('doctor reports the container channel', inspection.facts?.channel === 'container'")
    expect(source).toContain("check('the upgrade command is the docker one',\n    inspection.facts?.upgradeCommand === 'docker pull looptroopai/looptroop:latest'")
  })

  it('wires every smoke consumer to structured facts and consumes matches or individual facts', () => {
    for (const contract of wiringContracts) {
      const source = parseSource(contract.file)
      const { calls, properties } = collectNodes(source)

      expect(importsSharedInspector(source), contract.file).toBe(true)
      expect(calls, contract.file).toHaveLength(contract.calls)

      const targets = calls.map(assignedName)
      expect(targets, contract.file).toEqual(expect.arrayContaining([...contract.targets]))

      for (const call of calls) {
        const facts = call.arguments[1]
        if (!facts) {
          expect(facts, contract.file).toBeDefined()
          continue
        }
        expect(ts.isObjectLiteralExpression(facts), contract.file).toBe(true)
        if (!ts.isObjectLiteralExpression(facts)) continue

        const channel = facts.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === 'channel',
        )
        const upgrade = facts.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === 'upgradeCommand',
        )

        expect(channel, contract.file).toBeDefined()
        expect(upgrade, contract.file).toBeDefined()
        if (!channel || !upgrade) continue
        expect(stringLiterals(channel.initializer), contract.file).toContain(contract.channel)
        const upgradeValues = stringLiterals(upgrade.initializer)
        for (const value of contract.upgrades) {
          expect(upgradeValues, contract.file).toContain(value)
        }
      }

      const matchesTargets = new Set(
        properties
          .filter((property) => property.name.text === 'matches' || property.name.text === 'facts')
          .map((property) => rootIdentifier(property.expression)),
      )
      for (const target of contract.targets) {
        expect(matchesTargets, `${contract.file}: ${target}.matches`).toContain(target)
      }

      expect(
        properties.filter(hasDoctorDetailRead),
        `${contract.file}: prose detail classification`,
      ).toHaveLength(0)
    }
  })
})
