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
const sharedHelperRedeclarationRules = [
  'isRecord',
  'getErrorMessage',
  'normalizeString',
  'stripAnsiSequences',
].flatMap((name) => [
  {
    selector: `FunctionDeclaration[id.name='${name}']`,
    message: `Import ${name} from @shared/typeGuards or @shared/ansi instead of redeclaring it.`,
  },
  {
    selector: `VariableDeclarator[id.name='${name}'][init.type=/FunctionExpression|ArrowFunctionExpression/]`,
    message: `Import ${name} from @shared/typeGuards or @shared/ansi instead of redeclaring it.`,
  },
])

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
      'no-restricted-syntax': ['error', ...sharedHelperRedeclarationRules],
    },
  },
  {
    // The canonical definitions themselves, and the two documented exceptions.
    files: [
      'shared/typeGuards.ts',
      'shared/ansi.ts',
      'shared/errorDisplay.ts',
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
