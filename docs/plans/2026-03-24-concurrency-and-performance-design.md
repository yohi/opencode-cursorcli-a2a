# Design: Concurrency and Event Loop Fixes

## 1. Coalescing Server Startup (ServerManager)

### Problem
Concurrent calls to `ServerManager.ensureRunning` for the same port can both see `probePort` fail and both proceed to spawn a new server process. This results in duplicate processes, with one process overwriting the other in the `servers` map, leading to untracked zombie processes.

### Proposed Solution
Use a `startingUp` map to track in-flight server startups per port.

#### Key Components:
- `private startingUp = new Map<number, Promise<void>>();`
- When `ensureRunning` is called:
  1. If `probePort` is true, return immediately.
  2. If `this.servers.has(port)`, increment `refCount` and return.
  3. If `this.startingUp.has(port)`, `await` the promise and then recursively call `ensureRunning` to check the updated state.
  4. If not, start the server:
     - Create a startup promise `Promise.resolve().then(() => this._startServer(...))`.
     - Add to `startingUp`.
     - `finally` remove from `startingUp`.
     - `await` it.

### Verification Strategy
Create a test case in `src/server-manager.test.ts` that calls `ensureRunning` multiple times concurrently for the same port and asserts that only one `spawn` occurs.

## 2. Non-blocking Cursor CLI Detection (findCursorCommand)

### Problem
`findCursorCommand` uses `execSync` to run `which cursor` (or `where cursor` on Windows), which blocks the Node.js event loop. This is called within an async context (`executeCursorAgentStream`), which can cause significant latency in a concurrent server.

### Proposed Solution
1. Cache the detected command path in a module-level variable.
2. Convert `findCursorCommand` to be asynchronous to avoid blocking.

#### Key Components:
- `let _cachedCursorCmd: string | null = null;`
- `export async function findCursorCommand(): Promise<string>`
- Use `exec` or `spawn` asynchronously for the command lookup.
- Update all callers (only `executeCursorAgentStream`) to `await` the result.

### Verification Strategy
Create a test case in `src/server/cursor-agent-service.test.ts` that calls `findCursorCommand` multiple times and verifies that the detection logic is only executed once. Also, verify it doesn't block the event loop by running a timer alongside the call.
