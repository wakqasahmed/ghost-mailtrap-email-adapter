export default [
    {
        ignores: ['node_modules/', 'coverage/', 'reference/']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                AbortSignal: 'readonly',
                afterEach: 'readonly',
                beforeEach: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                describe: 'readonly',
                fetch: 'readonly',
                globalThis: 'readonly',
                it: 'readonly',
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
                setTimeout: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^(err|handlerError|parent)$',
                    caughtErrors: 'none'
                }
            ]
        }
    }
];
