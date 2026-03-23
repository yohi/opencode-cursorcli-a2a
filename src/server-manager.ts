/**
 * Server Manager for Cursor Agent
 * 
 * Responsible for starting and stopping the internal A2A server.
 * Prioritizes the internal server over external libraries.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AutoStartConfig {
    serverPath?: string;
    env?: Record<string, string>;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
}

function probePort(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = createConnection({ port, host });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
        sock.setTimeout(300, () => { sock.destroy(); resolve(false); });
    });
}

function waitForPort(port: number, host: string, timeoutMs: number, pollMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = async () => {
            if (await probePort(port, host)) { resolve(); return; }
            if (Date.now() >= deadline) {
                reject(new Error(`[ServerManager] Server did not become ready on ${host}:${port} within ${timeoutMs}ms`));
                return;
            }
            setTimeout(poll, pollMs);
        };
        poll();
    });
}

/**
 * Resolves the path to the internal or external server entry point.
 */
export function resolveServerPath(overridePath?: string): string {
    if (overridePath && existsSync(overridePath)) {
        return overridePath;
    }

    // 1. Internal Server (dist/server.js)
    try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const internalServer = path.resolve(currentDir, '..', 'dist', 'server.js');
        if (existsSync(internalServer)) return internalServer;
        
        // Try development path
        const devServer = path.resolve(currentDir, 'server', 'index.ts');
        if (existsSync(devServer)) return devServer;
    } catch {
        // Fallback to other searches
    }

    // 2. Local node_modules fallback
    try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const localServer = path.resolve(currentDir, '..', 'node_modules', 'cursor-agent-a2a', 'dist', 'index.js');
        if (existsSync(localServer)) return localServer;
    } catch {
        // Continue searching
    }

    throw new Error('[ServerManager] Could not locate Cursor A2A server. Please build the project first.');
}

interface ManagedServer {
    proc: ChildProcess;
    port: number;
    host: string;
    refCount: number;
}

export class ServerManager {
    private static instance: ServerManager | undefined;
    private servers = new Map<number, ManagedServer>();

    private constructor() {}

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    async ensureRunning(
        port: number,
        host: string,
        modelId: string,
        config: AutoStartConfig,
        debug: boolean = false
    ): Promise<() => void> {
        if (await probePort(port, host)) {
            return () => {}; // Already running
        }

        const existing = this.servers.get(port);
        if (existing) {
            existing.refCount++;
            return this.makeReleaseFn(port);
        }

        // New server startup
        const serverPath = resolveServerPath(config.serverPath);
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            PORT: String(port),
            HOST: host,
            CURSOR_DEFAULT_MODEL: modelId,
            ...config.env,
        };

        const args = serverPath.endsWith('.ts') ? ['--no-warnings', 'node_modules/tsx/dist/cli.mjs', serverPath] : [serverPath];
        const cmd = 'node';

        const proc = spawn(cmd, args, {
            env,
            stdio: debug ? 'inherit' : 'ignore',
            detached: false,
        });

        const entry: ManagedServer = { proc, port, host, refCount: 1 };
        this.servers.set(port, entry);

        const pollMs = config.pollIntervalMs ?? 200;
        const timeoutMs = config.startupTimeoutMs ?? 15000;

        try {
            await Promise.race([
                waitForPort(port, host, timeoutMs, pollMs),
                new Promise<void>((_, reject) => {
                    proc.on('error', (err) => reject(new Error(`Server spawn error: ${err.message}`)));
                    proc.once('exit', (code) => {
                        if (code !== 0 && code !== null) {
                            reject(new Error(`Server exited early with code ${code}`));
                        }
                    });
                }),
            ]);
        } catch (err) {
            proc.kill();
            this.servers.delete(port);
            throw err;
        }

        return this.makeReleaseFn(port);
    }

    private makeReleaseFn(port: number): () => void {
        return () => {
            const entry = this.servers.get(port);
            if (!entry) return;
            entry.refCount--;
            if (entry.refCount <= 0) {
                entry.proc.kill();
                this.servers.delete(port);
            }
        };
    }

    public dispose() {
        for (const [, entry] of this.servers) {
            entry.proc.kill();
        }
        this.servers.clear();
    }
}
