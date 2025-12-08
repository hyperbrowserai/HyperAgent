/** @type {import('jest').Config} */
module.exports = {
  // Ignore example/runner scripts that aren't meant to be Jest suites.
  testPathIgnorePatterns: ["/node_modules/", "/scripts/"],
  // Allow compiled tests in dist/ to resolve internal "@/..." aliases.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/dist/$1",
  },
};
