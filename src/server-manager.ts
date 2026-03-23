/**
 * Server Manager for Cursor Agent
 * 
 * Responsible for starting and stopping the internal A2A server.
 * Prioritizes the internal server over external libraries.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AutoStartConfig {
    serverPath?: string;
    env?: Record<string, string>;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
}

export async function probePort(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        // Normalize IPv6 literals
        const normalizedHost = (host.includes(':') && !host.startsWith('[') && !host.endsWith(']'))
            ? `[${host}]`
            : host;
        const url = `http://${normalizedHost}:${port}/health`;
        const timeoutMs = 500;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        fetch(url, { signal: controller.signal })
            .then(async (res) => {
                if (!res.ok) {
                    resolve(false);
                    return;
                }
                const data = await res.json() as { service?: string };
                // Check for our specific service identifier
                resolve(!!(data && data.service === 'opencode-cursor-a2a-internal'));
            })
            .catch(() => resolve(false))
            .finally(() => clearTimeout(timeoutId));
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
        let currentDir: string;
        try {
            // @ts-ignore: ESM-only property
            if (typeof import.meta !== 'undefined' && import.meta.url) {
                currentDir = path.dirname(fileURLToPath(import.meta.url));
            } else {
                // Fallback for CJS
                currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
            }
        } catch {
            currentDir = process.cwd();
        }

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
        let currentDir: string;
        try {
            // @ts-ignore: ESM-only property
            if (typeof import.meta !== 'undefined' && import.meta.url) {
                currentDir = path.dirname(fileURLToPath(import.meta.url));
            } else {
                currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
            }
        } catch {
            currentDir = process.cwd();
        }
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
    private servers = new Map<string, ManagedServer>();
    private startingUp = new Map<string, Promise<void>>();

    private constructor() {}

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    private getKey(port: number, host: string): string {
        return `${host}:${port}`;
    }

    async ensureRunning(
        port: number,
        host: string,
        modelId: string,
        config: AutoStartConfig,
        debug: boolean = false
    ): Promise<() => void> {
        const key = this.getKey(port, host);

        // 1. Check if already managed
        const existing = this.servers.get(key);
        if (existing) {
            existing.refCount++;
            return this.makeReleaseFn(key);
        }

        // 2. Check if it is already being started by another call
        const ongoing = this.startingUp.get(key);
        if (ongoing) {
            await ongoing;
            // After startup finishes, check again (it might be managed now)
            return this.ensureRunning(port, host, modelId, config, debug);
        }

        // 3. Start the startup/probe process
        const startupPromise = (async () => {
            // Check if already running (external)
            if (await probePort(port, host)) {
                return;
            }

            const serverPath = resolveServerPath(config.serverPath);
            const env: Record<string, string> = {
                ...(process.env as Record<string, string>),
                PORT: String(port),
                HOST: host,
                CURSOR_DEFAULT_MODEL: modelId,
                ...config.env,
            };

            const args = serverPath.endsWith('.ts') ? ['tsx', serverPath] : [serverPath];
            const cmd = serverPath.endsWith('.ts') ? 'npx' : 'node';

            const proc = spawn(cmd, args, {
                env,
                stdio: debug ? 'inherit' : 'ignore',
                detached: false,
                shell: process.platform === 'win32',
            });

            const pollMs = config.pollIntervalMs ?? 200;
            const timeoutMs = config.startupTimeoutMs ?? 15000;

            try {
                await new Promise<void>((resolve, reject) => {
                    const timeoutId = setTimeout(() => {
                        done(new Error(`[ServerManager] Server did not become ready on ${host}:${port} within ${timeoutMs}ms`));
                    }, timeoutMs);

                    const pollInterval = setInterval(async () => {
                        if (await probePort(port, host)) {
                            done();
                        }
                    }, pollMs);

                    const onError = (err: Error) => done(new Error(`Server spawn error: ${err.message}`));
                    const onExit = (code: number | null, signal: string | null) => 
                        done(new Error(`Server exited prematurely (code: ${code}, signal: ${signal})`));

                    proc.on('error', onError);
                    proc.once('exit', onExit);

                    function done(err?: Error) {
                        clearTimeout(timeoutId);
                        clearInterval(pollInterval);
                        proc.removeListener('error', onError);
                        proc.removeListener('exit', onExit);
                        if (err) reject(err);
                        else resolve();
                    }
                });
            } catch (err) {
                proc.kill();
                throw err;
            }

            // Registration only after successful readiness wait
            const entry: ManagedServer = { proc, port, host, refCount: 0 }; 
            this.servers.set(key, entry);

            // Stability: Remove from servers if it exits unexpectedly after startup
            const cleanupExit = () => {
                if (this.servers.get(key)?.proc === proc) {
                    this.servers.delete(key);
                }
            };
            proc.once('exit', cleanupExit);
        })();

        this.startingUp.set(key, startupPromise);
        try {
            await startupPromise;
        } finally {
            this.startingUp.delete(key);
        }

        // 4. Final check and return release function
        const managed = this.servers.get(key);
        if (managed) {
            managed.refCount++;
            return this.makeReleaseFn(key);
        }

        // If it was an external server
        if (await probePort(port, host)) {
            return () => {};
        }

        throw new Error(`[ServerManager] Failed to ensure server is running on ${host}:${port}`);
    }

    private makeReleaseFn(key: string): () => void {
        return () => {
            const entry = this.servers.get(key);
            if (!entry) return;
            entry.refCount--;
            if (entry.refCount <= 0) {
                entry.proc.kill();
                this.servers.delete(key);
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
