/**
 * The library's own code is pure TypeScript with no React Native runtime
 * dependency, so the unit suite runs under plain Node with babel-jest (which
 * reuses babel.config.js to strip types). The `executorchBackend` end-to-end
 * path requires a real device/simulator and is therefore excluded from CI — see
 * CONTRIBUTING.md.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageThreshold: {
    './src/policy/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
