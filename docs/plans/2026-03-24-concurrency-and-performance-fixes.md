# Concurrency and Performance Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the race condition in `ServerManager.ensureRunning` and the event loop blocking in `findCursorCommand`.

**Architecture:** 
- Use a `startingUp` map in `ServerManager` to coalesce concurrent server startups for the same port.
- Cache the result of `findCursorCommand` and convert it to an asynchronous function using `exec` or `spawn` to avoid blocking the event loop.

**Tech Stack:** TypeScript, Node.js (child_process, Map, Promises), Vitest.

---

## Task 1: Fix Race Condition in `ServerManager.ensureRunning`

**Files:**
- Modify: `src/server-manager.ts`
- Create: `src/server-manager.test.ts`

**Step 1: Write the failing test for race condition**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerManager } from './server-manager';
import * as serverManagerMod from './server-manager';

describe('ServerManager Concurrency', () => {
    it('should only spawn one server when called concurrently for the same port', async () => {
        const manager = ServerManager.getInstance();
        // Mock probePort to return false initially
        const probePortSpy = vi.spyOn(serverManagerMod as any, 'probePort').mockResolvedValue(false);
        // Mock resolveServerPath to return a dummy path
        vi.spyOn(serverManagerMod as any, 'resolveServerPath').mockReturnValue('dummy-path.js');
        
        // Mock spawn to return a dummy process that doesn't exit immediately
        const mockProc = {
            on: vi.fn(),
            once: vi.fn(),
            kill: vi.fn(),
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
        };
        const spawnSpy = vi.spyOn(require('node:child_process'), 'spawn').mockReturnValue(mockProc as any);

        // Mock waitForPort to resolve
        vi.spyOn(serverManagerMod as any, 'waitForPort').mockResolvedValue(undefined);

        // Call concurrently
        const p1 = manager.ensureRunning(4937, '127.0.0.1', 'auto', {});
        const p2 = manager.ensureRunning(4937, '127.0.0.1', 'auto', {});

        await Promise.all([p1, p2]);

        expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest src/server-manager.test.ts`
Expected: FAIL (spawnSpy called twice)

**Step 3: Implement the fix in `src/server-manager.ts`**

```typescript
// Add startingUp map
private startingUp = new Map<number, Promise<void>>();

// Modify ensureRunning
async ensureRunning(...): Promise<() => void> {
    if (await probePort(port, host)) return () => {};

    const existing = this.servers.get(port);
    if (existing) {
        existing.refCount++;
        return this.makeReleaseFn(port);
    }

    // Coalesce concurrent starters
    const inflight = this.startingUp.get(port);
    if (inflight) {
        await inflight;
        return this.ensureRunning(port, host, modelId, config, debug);
    }

    const startupPromise = (async () => {
        // ... existing spawn and waitForPort logic ...
    })();

    this.startingUp.set(port, startupPromise);
    try {
        await startupPromise;
    } finally {
        this.startingUp.delete(port);
    }

    return this.makeReleaseFn(port);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest src/server-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server-manager.ts src/server-manager.test.ts
git commit -m "fix: ServerManagerの競合状態を解消し、同一ポートへの同時起動を制御"
```

---

## Task 2: Fix Event Loop Blocking in `findCursorCommand`

**Files:**
- Modify: `src/server/cursor-agent-service.ts`
- Create: `src/server/cursor-agent-service.test.ts`

**Step 1: Write the failing test for blocking and caching**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { findCursorCommand } from './cursor-agent-service';
import * as childProcess from 'node:child_process';

describe('findCursorCommand', () => {
    it('should cache the result and only call detection once', async () => {
        const execSyncSpy = vi.spyOn(childProcess, 'execSync').mockReturnValue(Buffer.from('path/to/cursor'));
        
        // This will be synchronous in the current version, failing the test if we expect it to be async
        const path1 = findCursorCommand();
        const path2 = findCursorCommand();
        
        expect(path1).toBe(path2);
        expect(execSyncSpy).toHaveBeenCalledTimes(1);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest src/server/cursor-agent-service.test.ts`
Expected: FAIL (or needs modification because we are changing the signature to async)

**Step 3: Implement the fix in `src/server/cursor-agent-service.ts`**

1. Add `let _cachedCursorCmd: string | null = null;`.
2. Convert `findCursorCommand` to `async` and use `exec` (async) instead of `execSync`.
3. Update `executeCursorAgentStream` to `await findCursorCommand()`.

**Step 4: Run test to verify it passes**

Update the test to `await findCursorCommand()` and use a spy for `exec`.
Run: `npx vitest src/server/cursor-agent-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/cursor-agent-service.ts src/server/cursor-agent-service.test.ts
git commit -m "perf: findCursorCommandを非同期化・キャッシュ化し、イベントループのブロックを解消"
```
