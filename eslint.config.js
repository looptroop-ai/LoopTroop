import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * Guards the shared helpers against re-divergence.
 *
 * Each of these existed in between two and twenty-eight copies before they were
 * consolidated, and every copy started as someone writing the obvious four-line
 * function rather than looking for it. A local re-declaration is what re-opens
 * the drift, so it is the thing this bans — the canonical modules and the two
 * variants that genuinely differ are exempted below.
 */
const SHARED_HELPER_HOMES = {
  isRecord: '@shared/typeGuards',
  getErrorMessage: '@shared/typeGuards',
  normalizeString: '@shared/typeGuards',
  stripAnsiSequences: '@shared/ansi',
}

const sharedHelperRedeclarationRules = Object.entries(SHARED_HELPER_HOMES).flatMap(([name, home]) => {
  const message = `Import ${name} from ${home} instead of redeclaring it.`
  return [
    // `function isRecord() {}`
    { selector: `FunctionDeclaration[id.name='${name}']`, message },
    // `const isRecord = () => {}` / `= function () {}`
    {
      selector: `VariableDeclarator[id.name='${name}'][init.type=/FunctionExpression|ArrowFunctionExpression/]`,
      message,
    },
    // `const f = function isRecord() {}` — the name is on the expression, not the binding.
    { selector: `FunctionExpression[id.name='${name}']`, message },
    // `{ isRecord() {} }` and `class X { isRecord() {} }`
    { selector: `Property[key.name='${name}'][value.type=/FunctionExpression|ArrowFunctionExpression/]`, message },
    { selector: `MethodDefinition[key.name='${name}']`, message },
  ]
})

/**
 * Bans the bare program name that `PATH` gets to answer.
 *
 * `spawn('git', …)` names a tool and lets the operating system pick the file.
 * `shell: false` stops the *arguments* being re-parsed; it says nothing about
 * which binary runs, and the first directory on `PATH` decides. Every such site
 * in this repository now resolves through `server/lib/executablePath.ts` (or
 * `scripts/trusted-tool.ts` for the release jobs), and this is what stops the
 * next one being written the obvious way.
 *
 * AST, not grep. The selector matches a *string literal* in the program
 * position with no path separator in it — which is precisely "a name for PATH to
 * look up". A variable holding a resolved path does not match, and neither does
 * a literal absolute path, because in both cases the file has already been
 * chosen. Grep cannot tell those apart.
 *
 * The second clause is `shell: true` beside a literal command, because a shell
 * performs its own PATH resolution: handing cmd.exe or `sh -c` a bare name puts
 * the choice straight back where the first clause took it from. `shell` with a
 * *resolved path* is still allowed — Node has refused to launch a Windows `.cmd`
 * directly since the BatBadBut hardening, and there is no other way to run one.
 */
const SPAWN_CALLEES = 'spawn|spawnSync|exec|execSync|execFile|execFileSync'
/**
 * `exec` is left out when it is a *method*.
 *
 * `db.exec('BEGIN')` and `/re/.exec('text')` are both a bare-string first
 * argument on a member call named `exec`, and neither starts a process. The
 * `child_process` member form is not used here; the bare-identifier form still
 * is, and that clause keeps it.
 */
const SPAWN_METHODS = 'spawn|spawnSync|execFile|execFileSync'
/** A literal with no `/` or `\\` in it: a name, not a path. */
const BARE_NAME = String.raw`/^[^\\/]+$/`

const ambientProgramRules = [
  {
    selector: `CallExpression[callee.name=/^(${SPAWN_CALLEES})$/][arguments.0.type='Literal'][arguments.0.value=${BARE_NAME}]`,
    message:
      'Resolve the program before spawning it: findTrustedExecutablePath from server/lib/executablePath,'
      + ' toolPath from scripts/tool-path, or resolveTrustedTool from scripts/trusted-tool for a release job.'
      + ' A bare name lets the first directory on PATH decide which file runs.',
  },
  {
    selector: `CallExpression[callee.property.name=/^(${SPAWN_METHODS})$/][arguments.0.type='Literal'][arguments.0.value=${BARE_NAME}]`,
    message:
      'Resolve the program before spawning it: findTrustedExecutablePath from server/lib/executablePath,'
      + ' toolPath from scripts/tool-path, or resolveTrustedTool from scripts/trusted-tool for a release job.'
      + ' A bare name lets the first directory on PATH decide which file runs.',
  },
  {
    selector:
      `CallExpression[callee.name=/^(${SPAWN_CALLEES})$/][arguments.0.type='Literal']`
      + " ObjectExpression > Property[key.name='shell'][value.value=true]",
    message:
      'A shell resolves the command through PATH itself, so a literal command with `shell: true` is the same hole.'
      + ' Resolve the program first and pass the quoted path, which is what a Windows .cmd shim needs anyway.',
  },
]

export default tseslint.config(
  { ignores: ['dist', 'site', 'docs/.vitepress', 'node_modules', '.looptroop'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-unassigned-vars': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', ...sharedHelperRedeclarationRules, ...ambientProgramRules],
    },
  },
  {
    /**
     * The `.mjs` scripts, for this one rule only.
     *
     * They were outside the linted set entirely — the config has always
     * matched TypeScript only — which is why `installer-core.mjs` and the smoke
     * scripts were the largest remaining group of bare program names. Turning on
     * the recommended sets here would be a separate change with its own fallout;
     * what this needs is the ambient-program guard, which is what it gets.
     */
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-syntax': ['error', ...ambientProgramRules],
    },
  },
  {
    /**
     * Test scaffolding spawns `git` by name, and stays that way.
     *
     * These run under vitest against a fixture repository the test just made:
     * there is no ambient `PATH` to be hijacked that is not already the test
     * runner's own, and the alternative is indirection in scaffolding to satisfy
     * a rule about production behaviour. This is the same call the plan makes
     * for the ten S4036 alerts in `server/test/`, which are dismissed rather
     * than fixed — recorded here so the two decisions cannot drift apart.
     *
     * Only the ambient-program clauses are lifted; the shared-helper ones still
     * apply.
     */
    files: ['**/__tests__/**', '**/*.test.ts', 'server/test/**', 'tests/**'],
    rules: {
      'no-restricted-syntax': ['error', ...sharedHelperRedeclarationRules],
    },
  },
  {
    // The canonical definitions themselves, and the two documented exceptions.
    // Nothing else belongs here: an exemption is a hole in the guard, and this
    // list once carried `shared/errorDisplay.ts`, which declares none of these.
    files: [
      'shared/typeGuards.ts',
      'shared/ansi.ts',
      // Returns '' for non-Error values because callers regex-match the result.
      'src/lib/lazyWithChunkReload.ts',
      // Returns `string | null`, not `string | undefined`.
      'server/git/github.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
)
