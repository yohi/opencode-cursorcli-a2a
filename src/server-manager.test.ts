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

describe('ServerManager', () => {
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
            off: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            unref: vi.fn(),
        };
        (spawn as any).mockReturnValue(mockProc);

        // Trigger two concurrent calls to ensureRunning
        const p1 = sm.ensureRunning(port, host, modelId, config);
        const p2 = sm.ensureRunning(port, host, modelId, config);

        const [release1, release2] = await Promise.all([p1, p2]);

        // Expect spawn to have been called only once.
        expect(spawn).toHaveBeenCalledTimes(1);

        // Clean up
        release1();
        release2();
    });

    it('should increment refCount when server is already running and managed', async () => {
        const port = 4938;
        const host = '127.0.0.1';
        const modelId = 'auto';
        const config = { pollIntervalMs: 10, startupTimeoutMs: 1000 };

        global.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ service: 'opencode-cursor-a2a-internal' })
            }) as any;

        const mockProc = {
            on: vi.fn(),
            once: vi.fn(),
            off: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            unref: vi.fn(),
        };
        (spawn as any).mockReturnValue(mockProc);

        const release1 = await sm.ensureRunning(port, host, modelId, config);
        expect(spawn).toHaveBeenCalledTimes(1);

        const release2 = await sm.ensureRunning(port, host, modelId, config);
        
        release1();
        expect(mockProc.kill).not.toHaveBeenCalled();

        release2();
        expect(mockProc.kill).toHaveBeenCalledTimes(1);
    });

    it('should remove server from managed list on exit', async () => {
        const port = 4939;
        const host = '127.0.0.1';
        const modelId = 'auto';
        const config = { pollIntervalMs: 10, startupTimeoutMs: 1000 };

        const exitHandlers: Set<(code: number | null, signal: string | null) => void> = new Set();
        const mockProc = {
            on: vi.fn(),
            once: vi.fn().mockImplementation((event, handler) => {
                if (event === 'exit') exitHandlers.add(handler);
            }),
            off: vi.fn().mockImplementation((event, handler) => {
                if (event === 'exit') exitHandlers.delete(handler);
            }),
            removeListener: vi.fn().mockImplementation((event, handler) => {
                if (event === 'exit') exitHandlers.delete(handler);
            }),
            kill: vi.fn(),
            unref: vi.fn(),
        };
        (spawn as any).mockReturnValue(mockProc);

        global.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ service: 'opencode-cursor-a2a-internal' })
            }) as any;

        await sm.ensureRunning(port, host, modelId, config);
        
        // Simulate exit
        const handlers = Array.from(exitHandlers);
        handlers.forEach(h => h(1, null));

        (spawn as any).mockClear();
        global.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ service: 'opencode-cursor-a2a-internal' })
            }) as any;
        await sm.ensureRunning(port, host, modelId, config);
        expect(spawn).toHaveBeenCalledTimes(1);
    });
});
