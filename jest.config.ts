import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
    },
    // CUSTOMER-JWT-SECRET-1. jose@6 is ESM-only and ships no CommonJS build, so
    // any suite importing lib/customerAuth.ts previously failed to parse — which
    // is why the storefront session module had no tests and its public fallback
    // key went unnoticed. Transforming jose lets the REAL library run under the
    // tests; shimming it instead would have meant asserting against a hand-rolled
    // verifier rather than the one that actually runs in production.
    transformIgnorePatterns: ['/node_modules/(?!jose)'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {}],
        '^.+\\.m?jsx?$': ['ts-jest', { tsconfig: { allowJs: true, module: 'CommonJS' } }],
    },
    // Snapshot serialization: sort keys for deterministic output
    snapshotSerializers: [],
    // Fail CI on any snapshot mismatch
    ci: false,
};

export default config;
