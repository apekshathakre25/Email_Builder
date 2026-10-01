import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module'
      }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Providers export their own consumer hook alongside the component, which is the
      // conventional layout and keeps the context private to the module. Naming them here
      // rather than splitting each provider across two files.
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          allowExportNames: ['useAuth', 'useToast', 'useConfirm', 'useAppConfig']
        }
      ],

      // Unused args are common in event handlers and React callbacks; leading
      // underscore is the escape hatch. Caught variables are ignored because
      // `catch {}` without a binding is not supported by every tool in the chain.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],

      // console.warn/error carry real diagnostics for operators reporting a
      // problem; console.log is debugging left behind.
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  }
];
