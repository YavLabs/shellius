/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // .js is automatically treated as ESM when package.json has "type":"module"
  // Run tests with: NODE_OPTIONS='--experimental-vm-modules' jest
  testMatch: ['**/src/**/__tests__/**/*.test.js'],
  moduleNameMapper: {
    // Identity mapper — lets jest-resolve handle .js imports in ESM
  },
  // Exclude node_modules from transformation
  transformIgnorePatterns: ['/node_modules/'],
  // Use the built-in jest ESM support (no babel needed)
  transform: {},
};
