import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'

const verifier = fileURLToPath(new URL('../scripts/verify-package-contents.mjs', import.meta.url))
const policy = (content: string) => `<meta http-equiv="Content-Security-Policy" content="${content}">`
const valid = policy("default-src 'self'; connect-src 'self';")

it.each([
  ['valid head policy', valid, true],
  ['permissive policy beside a matching comment', `<!-- ${valid} -->${policy("connect-src 'self' https:;")}`, false],
  ['commented-out policy', `<!-- ${valid} -->`, false],
  ['policy inside noscript', `<noscript>${valid}</noscript>`, false],
  ['missing policy', '', false],
  ['duplicate connect directive', policy("connect-src https:; connect-src 'self';"), false],
] as const)('checks the packed client with %s', (_name, head, passes) => {
  const root = makeTempDir('looptroop-package-csp-')
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'package-csp-fixture', version: '1.0.0' }))
    for (const file of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md']) {
      writeFileSync(join(root, file), 'fixture\n')
    }
    mkdirSync(join(root, 'dist/client'), { recursive: true })
    writeFileSync(join(root, 'dist/client/index.html'), `<!doctype html><html><head>${head}</head><body></body></html>`)
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(passes ? 0 : 1)
    if (passes) expect(result.stdout).toContain('PASS:')
    else expect(result.stderr).toContain('The published client must restrict connect-src to the same origin.')
  } finally {
    removeTempDir(root)
  }
}, 45_000)
