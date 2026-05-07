import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
    },
    // Snapshot serialization: sort keys for deterministic output
    snapshotSerializers: [],
    // Fail CI on any snapshot mismatch
    ci: false,
};

export default config;
