module.exports = {
  rootDir: '../..',
  testEnvironment: 'jsdom',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/repros/react-flag-memory-stress/react-flag-memory-stress.spec.tsx'],
  moduleNameMapper: {
    '@openfeature/core': '<rootDir>/packages/shared/src',
    '@openfeature/web-sdk': '<rootDir>/packages/web/src',
  },
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/repros/react-flag-memory-stress/tsconfig.json',
      },
    ],
  },
};
