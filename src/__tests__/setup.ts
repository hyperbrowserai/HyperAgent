/**
 * Jest setup file - runs before each test file
 */

// Increase timeout for browser-related tests
jest.setTimeout(30000);

// Mock environment variables for tests
process.env.NODE_ENV = "test";

// Silence console during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    // Keep warn and error for visibility
    warn: console.warn,
    error: console.error,
  };
}

// Global test utilities
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      testUtils: {
        mockCDPClient: () => unknown;
        mockBrowserContext: () => unknown;
      };
    }
  }
}

// Export empty to make this a module
export {};
