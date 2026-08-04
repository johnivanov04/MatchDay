import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  {
    // ESLint 9 flat config does not read .gitignore, so generated and vendored
    // trees must be listed here as well. `supabase/.temp/` holds a minified
    // Deno runtime bundle written by `supabase start` / `supabase db reset`;
    // linting it produces hundreds of irrelevant errors.
    ignores: [
      '.next/**',
      'node_modules/**',
      '.tmp/**',
      'coverage/**',
      'next-env.d.ts',
      'supabase/.temp/**',
      'supabase/.branches/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Phase 1 hard requirement: the service-role key must never reach the
      // browser bundle. `src/lib/supabase/admin.ts` additionally carries
      // `import 'server-only'` and a runtime guard.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/supabase/admin', '@/lib/supabase/admin'],
              message:
                'Import the service-role client only from server-side modules under src/lib or src/server.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Server-side modules and tests are allowed to reach the privileged client.
    files: ['src/lib/**/*.ts', 'src/server/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];

export default config;
