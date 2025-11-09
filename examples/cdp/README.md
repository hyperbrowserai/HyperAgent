# CDP Connection Manager Examples

This directory contains examples and tests for the CDP (Chrome DevTools Protocol) Connection Manager.

## Overview

The `CDPConnectionManager` is a low-level library that provides direct access to Chrome DevTools Protocol without depending on Playwright. It handles:

- Launching local Chrome instances with remote debugging
- Connecting to remote CDP endpoints via WebSocket
- Managing CDP sessions and targets (pages/tabs)
- Sending CDP commands and receiving events
- Automatic reconnection and error handling
- Proper cleanup of processes and connections

## Files

- `test-connection-manager.ts` - Comprehensive test suite demonstrating all features
- `basic-usage.ts` - Simple example showing basic usage patterns

## Running the Tests

To run the comprehensive test:

```bash
yarn ts-node examples/cdp/test-connection-manager.ts
```

To run the basic usage example:

```bash
yarn ts-node examples/cdp/basic-usage.ts
```

## Basic Usage

```typescript
import { CDPConnectionManager } from "../../src/cdp/connection-manager";

const manager = new CDPConnectionManager();

// Launch Chrome locally
const endpoint = await manager.launchLocal({ headless: false });

// Connect to the browser
await manager.connect(endpoint);

// Create a new page
const targetId = await manager.createTarget("https://example.com");
const session = await manager.createSession(targetId);

// Enable Page domain
await manager.sendCommand(session, "Page.enable", {});

// Navigate to a URL
await manager.sendCommand(session, "Page.navigate", {
  url: "https://example.com"
});

// Listen to events
manager.addEventListener(session, "Page.loadEventFired", () => {
  console.log("Page loaded!");
});

// Cleanup
await manager.close();
```

## API Reference

### Constructor

```typescript
new CDPConnectionManager()
```

### Methods

#### `launchLocal(options?: LaunchLocalOptions): Promise<string>`

Launch a local Chrome instance with remote debugging enabled.

Options:
- `headless?: boolean` - Run Chrome in headless mode (default: false)
- `userDataDir?: string` - Custom user data directory
- `args?: string[]` - Additional Chrome arguments
- `executablePath?: string` - Custom Chrome executable path
- `port?: number` - Remote debugging port (default: 9222)

Returns the HTTP endpoint URL.

#### `connect(endpoint: string, autoReconnect?: boolean): Promise<void>`

Connect to a CDP endpoint via WebSocket.

#### `createSession(targetId?: string): Promise<CDPSession>`

Create a new CDP session. If no targetId is provided, creates a new blank page.

#### `sendCommand(session: CDPSession, method: string, params?: any): Promise<any>`

Send a CDP command to a session.

#### `listTargets(): Promise<CDPTarget[]>`

List all available targets (pages/tabs).

#### `createTarget(url?: string): Promise<string>`

Create a new target (page/tab). Returns the target ID.

#### `closeTarget(targetId: string): Promise<boolean>`

Close a target.

#### `addEventListener(session: CDPSession, event: string, listener: (params: any) => void): void`

Listen to CDP events on a session.

#### `removeEventListener(session: CDPSession, event: string, listener: (params: any) => void): void`

Remove an event listener.

#### `getStatus(): ConnectionStatus`

Get the current connection status.

#### `close(): Promise<void>`

Close all connections and cleanup resources.

### Events

The manager extends EventEmitter and emits the following events:

- `connected` - Successfully connected to browser
- `disconnected` - Disconnected from browser
- `error` - Connection or protocol error occurred
- `statusChange` - Connection status changed
- `targetCreated` - New target was created
- `targetDestroyed` - Target was destroyed

## CDP Protocol Reference

For a complete list of available CDP commands and events, see:
- [Chrome DevTools Protocol Documentation](https://chromedevtools.github.io/devtools-protocol/)
- [Protocol Viewer](https://vanilla.aslushnikov.com/?Protocol)

## Common Use Cases

### Taking Screenshots

```typescript
const { data } = await manager.sendCommand(session, "Page.captureScreenshot", {
  format: "png",
  quality: 80
});
// data is base64-encoded PNG
```

### Executing JavaScript

```typescript
const result = await manager.sendCommand(session, "Runtime.evaluate", {
  expression: "document.title",
  returnByValue: true
});
console.log(result.result.value);
```

### Waiting for Network Idle

```typescript
manager.addEventListener(session, "Network.loadingFinished", (params) => {
  console.log("Network request finished:", params.requestId);
});

await manager.sendCommand(session, "Network.enable", {});
```

### Interacting with Elements

```typescript
// Get DOM
await manager.sendCommand(session, "DOM.enable", {});

// Get document
const { root } = await manager.sendCommand(session, "DOM.getDocument", {});

// Query selector
const { nodeId } = await manager.sendCommand(session, "DOM.querySelector", {
  nodeId: root.nodeId,
  selector: "#myButton"
});
```

## Troubleshooting

### Chrome fails to launch

- Verify Chrome is installed at the expected path
- Try specifying `executablePath` explicitly
- Check if port 9222 is already in use

### WebSocket connection fails

- Ensure the endpoint URL is correct
- Check firewall settings
- Verify Chrome's remote debugging is enabled

### Commands timeout

- Increase `commandTimeout` in the manager
- Check if the page is responsive
- Verify the command syntax is correct

## Notes

- This is a low-level API. For most use cases, consider using higher-level abstractions.
- Always call `close()` to properly cleanup resources.
- The manager handles automatic reconnection for dropped connections.
- Event listeners are scoped to specific sessions.
