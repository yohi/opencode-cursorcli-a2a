
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerManager } from './server-manager';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
}));

describe('ServerManager Race Condition', () => {
    let sm: ServerManager;
    let originalFetch: typeof fetch;

    beforeEach(() => {
        sm = ServerManager.getInstance();
        sm.dispose();
        vi.clearAllMocks();
        originalFetch = global.fetch;
        (fs.existsSync as any).mockReturnValue(true);
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('should only spawn one server when called concurrently for the same port', async () => {
        const port = 4937;
        const host = '127.0.0.1';
        const modelId = 'auto';
        const config = { pollIntervalMs: 10, startupTimeoutMs: 1000 };

        // Mock fetch to simulate server health check
        let fetchCount = 0;
        global.fetch = vi.fn().mockImplementation(async () => {
            fetchCount++;
            // Delay to ensure concurrency
            await new Promise(resolve => setTimeout(resolve, 50));
            // Initial checks (one for each concurrent call)
            if (fetchCount <= 2) {
                // Return not ok to simulate server not running
                return {
                    ok: false,
                    json: async () => ({})
                };
            }
            // Subsequent calls (waitForPort)
            return {
                ok: true,
                json: async () => ({ service: 'opencode-cursor-a2a-internal' })
            };
        }) as any;

        // Mock spawn
        const mockProc = {
            on: vi.fn(),
            once: vi.fn(),
            kill: vi.fn(),
            unref: vi.fn(),
        };
        (spawn as any).mockReturnValue(mockProc);

        // Trigger two concurrent calls to ensureRunning
        // We use a small delay in fetch to ensure they both reach the 'not running' state
        const p1 = sm.ensureRunning(port, host, modelId, config);
        const p2 = sm.ensureRunning(port, host, modelId, config);

        const [release1, release2] = await Promise.all([p1, p2]);

        // Expect spawn to have been called only once if race condition is fixed.
        // In the current buggy implementation, it should be called twice.
        expect(spawn).toHaveBeenCalledTimes(1);

        // Clean up
        release1();
        release2();
    });
});
