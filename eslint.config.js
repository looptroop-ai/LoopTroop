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
/**
 * The call names that start a process.
 *
 * `execFileAsync` and `execAsync` are here because `promisify(execFile)` is how
 * this codebase spells the async form, and a promisified alias is otherwise a
 * name the rule has never heard of. Aliasing an import under any *other* name is
 * refused outright, below, so a new alias cannot quietly re-open the hole.
 */
const SPAWN_CALLEES = 'spawn|spawnSync|exec|execSync|execFile|execFileSync|execFileAsync|execAsync'
/**
 * `exec` is left out when it is a method on an arbitrary object.
 *
 * `db.exec('BEGIN')` and `/re/.exec('text')` are both a bare-string first
 * argument on a member call named `exec`, and neither starts a process. On an
 * object that *is* `child_process` — imported as a namespace — `exec` and
 * `execSync` are covered by their own clause.
 */
const SPAWN_METHODS = 'spawn|spawnSync|execFile|execFileSync'
const CHILD_PROCESS_NAMESPACES = 'childProcess|child_process|cp'
/** A string with no `/` or `\\` in it: a name, not a path. */
const BARE_NAME = String.raw`/^[^\\/]+$/`

const RESOLVE_MESSAGE =
  'Resolve the program before spawning it: resolveTrustedProgram and planProgramLaunch from'
  + ' server/lib/executablePath, launchTool or execTool from scripts/tool-path, or resolveTrustedTool from'
  + ' scripts/trusted-tool for a release job. A bare name lets the first directory on PATH decide which file'
  + ' runs, and a resolved Windows .cmd still needs the launch plan, because Node will not spawn one directly.'

/**
 * Every spelling of "a bare name in the program position" this codebase has
 * actually used or been caught using, as selector tails on a matched call.
 *
 * - a plain string: `spawn('git')`
 * - a template with no interpolation: `` spawn(`git`) ``
 * - the fallback of an `||` / `??`: `spawn(process.env.ComSpec || 'cmd.exe')`
 * - either branch of a conditional: `spawn(IS_WINDOWS ? 'npm.cmd' : 'npm')`
 *
 * A template *with* an interpolation is left alone — `${bin}/git` is how a
 * resolved directory is joined — and so is anything that is not a literal at
 * all, because a variable may hold a resolved path and the rule cannot tell.
 * That last gap is the one this rule cannot close: a local `run(command)`
 * helper hides the literal from it entirely.
 */
const BARE_PROGRAM_SHAPES = [
  `[arguments.0.type='Literal'][arguments.0.value=${BARE_NAME}]`,
  `[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=${BARE_NAME}]`,
  `[arguments.0.type='LogicalExpression'][arguments.0.right.type='Literal'][arguments.0.right.value=${BARE_NAME}]`,
  `[arguments.0.type='ConditionalExpression'][arguments.0.consequent.type='Literal'][arguments.0.consequent.value=${BARE_NAME}]`,
  `[arguments.0.type='ConditionalExpression'][arguments.0.alternate.type='Literal'][arguments.0.alternate.value=${BARE_NAME}]`,
]

const ambientProgramRules = [
  ...BARE_PROGRAM_SHAPES.flatMap((shape) => [
    { selector: `CallExpression[callee.name=/^(${SPAWN_CALLEES})$/]${shape}`, message: RESOLVE_MESSAGE },
    // A method call only counts on a `child_process` namespace. Matching any
    // object's `.spawn(…)` flagged `worker.spawn('job')` as a process launch,
    // which is how a rule earns suppressions. A namespace under any other name
    // is refused below, so this list is the whole set.
    {
      selector: `CallExpression[callee.object.name=/^(${CHILD_PROCESS_NAMESPACES})$/][callee.property.name=/^(${SPAWN_METHODS}|exec|execSync)$/]${shape}`,
      message: RESOLVE_MESSAGE,
    },
  ]),
  {
    // `import * as proc from 'node:child_process'` hides every `proc.exec(…)`
    // from the clause above, which knows the namespace by name.
    selector:
      "ImportDeclaration[source.value=/^(node:)?child_process$/] > ImportNamespaceSpecifier"
      + `[local.name!=/^(${CHILD_PROCESS_NAMESPACES})$/]`,
    message: `Import the child_process namespace as one of: ${CHILD_PROCESS_NAMESPACES.split('|').join(', ')}. Any other name hides its calls from the rule that requires programs to be resolved.`,
  },
  {
    // `const run = promisify(execFile)` is a launcher under a name the rule has
    // never heard of. The two names it knows are the ones this codebase uses.
    // `util.promisify(childProcess.execFile)` is the same launcher spelled
    // through two namespaces, and slipped past a clause that knew only the bare
    // names.
    selector:
      "VariableDeclarator[init.type='CallExpression']"
      + ":matches([init.callee.name='promisify'], [init.callee.property.name='promisify'])"
      + `:matches([init.arguments.0.name=/^(${SPAWN_CALLEES})$/], [init.arguments.0.property.name=/^(${SPAWN_CALLEES})$/])`
      + '[id.name!=/^(execFileAsync|execAsync)$/]',
    message: 'Name a promisified child_process launcher execFileAsync or execAsync, so the ambient-program rule can see its calls.',
  },
  {
    // `import { spawn as launch }` gives the rule a callee name it cannot
    // know. Nothing here needs the alias, so it is refused rather than tracked.
    selector:
      "ImportDeclaration[source.value=/^(node:)?child_process$/] > ImportSpecifier"
      + `[imported.name=/^(spawn|spawnSync|exec|execSync|execFile|execFileSync)$/]`
      + `[local.name!=/^(spawn|spawnSync|exec|execSync|execFile|execFileSync)$/]`,
    message:
      'Import child_process functions under their own names. An alias hides every call made through it from the'
      + ' rule that requires programs to be resolved before they are spawned.',
  },
  {
    selector:
      `CallExpression[callee.name=/^(${SPAWN_CALLEES})$/][arguments.0.type='Literal']`
      + " ObjectExpression > Property[key.name='shell'][value.value=true]",
    message:
      'A shell resolves the command through PATH itself, so a literal command with `shell: true` is the same hole.'
      + ' Resolve the program and start it with planProgramLaunch (launchTool in scripts), which is also how a'
      + ' Windows .cmd shim is started: through a resolved cmd.exe, with every argument escaped.',
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
    // Workflow artifacts must keep using ticket-scoped I/O. Metadata operations
    // remain available; low-level descriptor/binary exceptions need a local,
    // documented suppression rather than weakening the whole workflow boundary.
    files: ['server/workflow/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].map((name) => ({
          name,
          importNames: [
            'default', 'promises', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync',
            'appendFile', 'appendFileSync', 'open', 'openSync', 'createReadStream', 'createWriteStream',
            'read', 'readSync', 'write', 'writeSync',
          ],
          message: 'Use readTicketFile/writeTicketFile, or contained no-follow I/O for a validated root. Raw content I/O bypasses artifact containment.',
        })),
        patterns: [{
          group: ['**/io/atomicWrite', '**/io/atomicWrite.*'],
          importNames: ['safeAtomicWrite'],
          message: 'Use writeTicketFile, or safeAtomicWriteWithin with a validated root, for workflow artifacts.',
        }],
      }],
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
      // Neither tsc nor vitest reads these files, so an import that was never
      // written is found by the first run that reaches it. That is how
      // `smoke-binary.mjs` called a helper it did not import and broke every
      // binary lane after local lint and typecheck both passed.
      'no-undef': 'error',
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
